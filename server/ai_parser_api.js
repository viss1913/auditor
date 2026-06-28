const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { validateParsingRuleV2, isV2Rule } = require('./parsing_rule_v2_validate');
const { V2_ONLY_MSG } = require('./parse_preview');
const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');
const { analyzeExcelBuffer, listSheetNames } = require('./excel_preview');
const { fixUploadNamesMiddleware } = require('./fix_upload_filename');
const { analyzeLayout } = require('./analyze_layout');
const { buildColumnCatalog } = require('./excel_column_catalog');
const { pickPreferredSheet } = require('./excel_sheet_meta');
const { runParsePreview, withTempFile } = require('./parse_preview');
const { importFileToSnapshot } = require('./parse_snapshot_import');
const { createParseSnapshotStore } = require('./parse_snapshot_store');
const { createChatSessionStore } = require('./chat_session_store');
const { applySnapshotOperation } = require('./parse_snapshot_operations');
const { runEgrulCheck } = require('./egrul_martin');
const { isEgrulIntent } = require('./egrul_intent');
const { listParserProfiles, getParserProfile, resolveParserDispatch } = require('./parser_registry');
const { loadTargetRows, comparePreviewToTarget } = require('./compare_target');
const { applyTargetToRule, inferColumnsFromTargetHeaders } = require('./target_rule_infer');
const { loadExample } = require('./ai_prompts');
const { applyV2HintsFromUserMessage, bootstrapRuleFromUserMessage } = require('./rule_hints');
const { bootstrapRuleWithLlm, shouldBootstrapWithLlm } = require('./rule_bootstrap_llm');
const {
    buildTemplateMessage,
    generateMartinReply,
    generateMartinConverseReply,
    buildLlmContext,
} = require('./assist_martin');
const {
    buildProjectContextPack,
    buildUiContextFallback,
    mergeContextPacks,
} = require('./martin_context_pack');
const {
    executeTableQuery,
    formatQueryResultMessage,
    formatQueryResultForLlm,
} = require('./table_query_engine');
const { planTableQuery } = require('./table_query_llm');
const {
    applyScenario,
    resolveScenarioFromMessage,
    detectSuggestedScenario,
    getTreeSample,
    listScenarios,
    buildScenarioChoiceMessage,
    isAccountCard76,
} = require('./scenarios/registry');
const {
    extractDate,
    extractAddress,
    applyExtractFields,
    stripExtractedFromText,
    defaultExtractFields,
    inferExtractFieldsFromMessage,
    stripTargetsFromFields,
    classifyBatchUnique,
} = require('./cell_enrich');
const {
    parseResultTableCommand,
    formatColumnNotFoundMessage,
    actionNeedsSourceColumn,
} = require('./result_table_commands');
const { mergeResultTableCommand } = require('./result_table_resolve');
const { resolveTableCommand } = require('./result_table_resolve_command');
const { planResultTableActionWithLlm } = require('./result_table_llm');

const { buildSessionPlan, applyOrchestratorToLayoutMeta } = require('./orchestrator');
const { planTreeRuleWithLlm, isTreeIntentMessage } = require('./tree_rule_llm');
const { detectSourceKind } = require('./file_dispatch');
const { parse1cTsvExport } = require('./parse_1c_tsv');
const { resolveUpload, shouldRequireTreeConfirm } = require('./scenario_router');
const { parseUniversal, confirmPdfDraft } = require('./universal_parse/universal_parse_orchestrator');
const { parseRequestedTableColumns } = require('./document_scan_llm');
const { scenarioDisplayName } = require('./scenarios/catalog');
const { checkUkParseSanity } = require('./uk_sanity');
const {
    probeFileList,
    probeUploadedFile,
    parseOpifBatch,
    buildOpifAssistantMessage,
    detectBatchScenario,
    isOpifScenario,
    OPIF_SNAPSHOT_HEADERS,
    fileNameOf,
    MAX_BATCH_FILES,
} = require('./opif_martin');
const {
    buildParsePlan,
    buildParsePlanAsync,
    applyParsePlanToOrchestratorAnswers,
} = require('./orchestrator/parse_plan');
const { shouldParseAllSheets, parseAllExcelSheets, wantsMultiSheetExcelParse } = require('./multi_sheet_martin');
const {
    shouldUseStructureOrchestrator,
    runExcelStructureAutostart,
    buildStructureAutostartResponse,
    buildStructureRefusalHttpBody,
} = require('./structure_autostart');
const { applyAutostartDefaults } = require('./autostart_defaults');
const { isSmartDialogEnabled, shouldUseLlmReply } = require('./martin_flags');
const { resolveAnswerFromText } = require('./orchestrator/answer_resolve');
const { processAiChatWithTools, isToolsEnabled } = require('./martin_tools');
const { PREVIEW_ROWS_CLIENT } = require('./parse_snapshot_import');
const { safeResJson, safeResJsonAndLogChat, sanitizeParseApiBody } = require('./client_response_sanitize');
const { buildReasoningTrace } = require('./reasoning_trace');
const { ensureAuditorsSchema } = require('./auditor_schema');
const {
    auditorSlugFromRequest,
    resolveAuditor,
    listAuditors,
} = require('./auditor_context');
const { registerPdfParseScenarioRoutes } = require('./pdf_parse_scenario_api');
const { registerInboxRoutes } = require('./project_inbox_api');
const { registerReconcileRoutes } = require('./reconcile_api');
const { bootstrapMartinSession } = require('./martin_workspace');
const {
    resolveBatchMergeContext,
    runBatchWithMergeStrategy,
    handleUniversalAppend,
} = require('./batch_merge_runner');
const { getPool } = require('./db_pool');
const { ensureUsersSchema } = require('./user_schema');
const {
    assertProjectAccess,
    assertSnapshotAccess,
    assertChatAccess,
    sendAccessError,
    HttpError,
} = require('./project_access');

const pool = getPool();

const upload = multer({ storage: multer.memoryStorage() });
const snapshotStore = createParseSnapshotStore(pool);
const chatSessionStore = createChatSessionStore(pool);

ensureAuditorsSchema(pool).catch((err) => {
    console.error('[auditors] schema init failed:', err.message);
});
ensureUsersSchema(pool).catch((err) => {
    console.error('[users] schema init failed:', err.message);
});

function requireAuthUser(req, res) {
    if (!req.user?.id) {
        res.status(401).json({ error: 'Требуется вход' });
        return null;
    }
    return req.user;
}

async function maybeLinkSnapshotToChat({ chatSessionId, snapshotId, label, projectId }) {
    if (!chatSessionId || !snapshotId) return;
    const chat = await chatSessionStore.getChatSession(chatSessionId);
    if (!chat) return;
    let linkLabel = label;
    if (!linkLabel) {
        const snap = await snapshotStore.getSnapshot(snapshotId);
        if (snap) {
            linkLabel = [snap.sourceFileName, snap.sheetName].filter(Boolean).join(' · ') || `Таблица #${snapshotId}`;
        }
    }
    await chatSessionStore.linkSnapshot(chatSessionId, snapshotId, linkLabel);
    if (chat.title === 'Новый чат' && linkLabel) {
        await chatSessionStore.updateChatTitle(chatSessionId, linkLabel.split(' · ')[0] || linkLabel);
    }
}

async function logChatExchange({
    chatSessionId,
    projectId,
    snapshotId,
    userMessage,
    assistantMessage,
    toolCalls,
}) {
    if (!chatSessionId) return;
    if (userMessage) {
        await chatSessionStore.appendChatMessage({
            chatSessionId,
            projectId,
            snapshotId,
            role: 'user',
            content: userMessage,
        });
    }
    if (assistantMessage) {
        await chatSessionStore.appendChatMessage({
            chatSessionId,
            projectId,
            snapshotId,
            role: 'assistant',
            content: assistantMessage,
            toolCalls: toolCalls || null,
        });
    }
}

/** История чата для LLM: из body.messages или fallback из БД по chatSessionId. */
async function resolveChatHistory(body = {}) {
    let chatHistory = Array.isArray(body.messages) ? body.messages : [];
    const chatSessionId = body.chatSessionId ? parseInt(body.chatSessionId, 10) : null;
    if (chatSessionId && !chatHistory.length) {
        chatHistory = await chatSessionStore.getChatMessages(chatSessionId, 20);
    }
    return chatHistory
        .filter((m) => m?.role === 'user' || m?.role === 'assistant')
        .slice(-12)
        .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 2000) }));
}

async function importParseFromFile(file, rule, opts = {}) {
    const imported = await importFileToSnapshot(pool, {
        fileBuffer: file.buffer,
        fileName: file.originalname,
        rule,
        projectId: opts.projectId,
        sheetName: opts.sheetName || rule?.meta?.sheet_name,
        scenarioId: opts.scenarioId,
        ruleId: opts.ruleId,
    });
    if (!imported.ok) {
        return {
            ok: false,
            snapshotId: imported.snapshotId,
            parsePreview: null,
            warnings: imported.errors || [],
        };
    }
    return {
        ok: true,
        snapshotId: imported.snapshotId,
        parsePreview: imported.parsePreview,
        warnings: imported.warnings || [],
    };
}

async function getSnapshotRowsForCompare(snapshotId, maxRows = 5000) {
    const page = await snapshotStore.fetchRowsPage(snapshotId, { page: 1, limit: maxRows });
    if (!page) return null;
    const rows = page.rows.map((r) => {
        const copy = { ...r };
        delete copy.__rowIndex;
        return copy;
    });
    return { headers: page.headers, rows };
}

function parseJsonField(raw, fallback) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function validateRuleV2(rule) {
    if (!isV2Rule(rule)) return { ok: false, errors: [V2_ONLY_MSG] };
    return validateParsingRuleV2(rule);
}

async function fetchSavedRulesByProject(projectId) {
    const pid = parseInt(projectId, 10);
    if (!Number.isFinite(pid)) return [];
    try {
        const dbRes = await pool.query(
            'SELECT id, rule_json FROM parsing_rules WHERE project_id = $1 AND rule_schema_version = 2 ORDER BY created_at DESC LIMIT 30',
            [pid]
        );
        return dbRes.rows || [];
    } catch (err) {
        if (!/rule_schema_version/i.test(String(err.message || ''))) throw err;
        const fallback = await pool.query(
            'SELECT id, rule_json FROM parsing_rules WHERE project_id = $1 ORDER BY created_at DESC LIMIT 30',
            [pid]
        );
        return fallback.rows || [];
    }
}

function shouldUseLlmOnAutostart() {
    return shouldUseLlmReply();
}

async function buildText1cAutostartResponse(file, parsed, routed = {}, opts = {}) {
    const previewRows = parsed.rows.slice(0, PREVIEW_ROWS_CLIENT);
    const scenarioId =
        routed.scenarioId ||
        (parsed.profile === 'deals_registry_tsv' ? 'deals_registry_tsv' : 'card_90_tsv');
    const scenarioName = routed.scenarioName || scenarioDisplayName(scenarioId);
    const sourceFileName = fileNameOf(file) || file?.originalname || 'export.txt';
    const projectId = opts.projectId ? parseInt(opts.projectId, 10) : null;

    let snapshotId = null;
    try {
        snapshotId = await snapshotStore.createSnapshot({
            projectId: Number.isFinite(projectId) ? projectId : null,
            sourceFileName,
            sheetName: null,
            scenarioId,
            headers: parsed.headers,
            status: 'parsing',
        });
        await snapshotStore.importParsedRows(snapshotId, parsed.headers, parsed.rows);
        console.log(`[text1c] snapshot id=${snapshotId} rows=${parsed.rowCount}`);
    } catch (err) {
        console.error('[text1c] snapshot import failed', err.message);
        snapshotId = null;
    }

    const parts = [
        `Разобрала **текстовую выгрузку 1С** — сценарий **${scenarioName}**.`,
        `Строк: **${parsed.rowCount}**.`,
    ];
    if (snapshotId) {
        parts.push('Данные сохранены в БД — фильтры и вкладки работают по всем строкам.');
    } else {
        parts.push('⚠️ Не удалось сохранить в БД — доступно только превью.');
    }
    if (parsed.meta?.encoding && parsed.meta.encoding !== 'utf8') {
        parts.push(`Кодировка: ${parsed.meta.encoding}.`);
    }
    if (parsed.warnings?.length) parts.push(parsed.warnings.join(' '));

    return {
        ok: true,
        sourceKind: 'text_1c',
        parserProfile: 'kseniya',
        rule: null,
        snapshotId,
        parsePreview: {
            headers: parsed.headers,
            rows: previewRows,
            rowCount: parsed.rowCount,
        },
        compareResult: null,
        assistantMessage: parts.join('\n\n'),
        warnings: parsed.warnings || [],
        layoutAnalysis: {
            sourceKind: 'text_1c',
            profile: parsed.profile,
            meta: parsed.meta,
            recommended: {
                layout_type: 'fixed_columns',
                description: `Текстовая выгрузка 1С (${parsed.profile})`,
            },
            previewText: previewRows
                .slice(0, 5)
                .map((r) => `${r['Период'] || ''}\t${r['Контрагент'] || ''}\t${r['Сумма Кт'] ?? ''}`)
                .join('\n'),
        },
        sheetNames: [],
        sheetName: null,
        needsScenarioChoice: false,
        scenarioId,
        scenarioName,
        confidence: routed.confidence ?? 1,
        candidates: [],
        treeSample: [],
        pendingQuestions: [],
        currentQuestion: null,
        sessionState: { step: 'ready', profileId: 'kseniya_text' },
        previewTruncated: parsed.rowCount > PREVIEW_ROWS_CLIENT,
    };
}

function computeRuleDiff(before, after) {
    if (!before) return { changes: ['создано новое правило'] };
    const changes = [];
    if (before.layout?.layout_type !== after.layout?.layout_type) {
        changes.push(`layout_type: ${before.layout?.layout_type} → ${after.layout?.layout_type}`);
    }
    if (before.meta?.sheet_name !== after.meta?.sheet_name) {
        changes.push(`лист: ${before.meta?.sheet_name || '—'} → ${after.meta?.sheet_name || '—'}`);
    }
    const bt = (before.columns || []).map((c) => c.target).join('|');
    const at = (after.columns || []).map((c) => c.target).join('|');
    if (bt !== at) changes.push('изменён набор columns');
    return { changes: changes.length ? changes : ['мелкие правки в правиле'] };
}

async function buildUniversalAutostartResponse(file, routed, { projectId, userMessage, orchestratorAnswers } = {}) {
    const result = await parseUniversal({
        pool,
        file,
        projectId,
        userMessage: userMessage || '',
        orchestratorAnswers: orchestratorAnswers || {},
    });
    if (!result.ok && result.errors) {
        return { ok: false, errors: result.errors };
    }
    if (result.delegateDepo) {
        return { ok: false, delegateDepo: true, routed: result };
    }
    const scenarioId = result.scenarioId || routed.scenarioId;

    if (result.multiSheet && Array.isArray(result.snapshots) && result.snapshots.length > 1) {
        return {
            ok: true,
            multiSheet: true,
            multiTable: Boolean(result.multiTable),
            snapshots: result.snapshots,
            sheetNames: result.sheetNames || result.snapshots.map((s) => s.sheetName).filter(Boolean),
            snapshotId: result.snapshots[0]?.snapshotId || result.snapshotId,
            parsePreview: result.snapshots[0]?.parsePreview || result.parsePreview,
            compareResult: null,
            assistantMessage: result.assistantMessage,
            warnings: result.warnings || [],
            layoutMeta: result.layoutMeta || routed.layoutMeta,
            needsScenarioChoice: Boolean(result.needsScenarioChoice),
            needsConfirm: Boolean(result.needsConfirm),
            scenarioId,
            scenarioName: result.scenarioName || scenarioDisplayName(scenarioId),
            confidence: result.confidence ?? routed.confidence,
            sourceKind: result.sourceKind || routed.sourceKind,
            candidates: result.candidates || routed.candidates || [],
            treeSample: [],
            pendingQuestions: result.needsConfirm
                ? [{ id: 'confirm_parse', text: 'Подтверди результат парсинга или уточни поля в чате.' }]
                : [],
            currentQuestion: result.needsConfirm ? { id: 'confirm_parse' } : null,
            sessionState: {
                step: result.needsConfirm ? 'confirm' : 'ready',
                profileId: routed.profileId || 'pavel',
                scenarioId,
            },
            meta: result.meta || null,
            engine: result.engine,
            scenarioResolution: result.scenarioResolution || null,
            gridDiagnostics: result.gridDiagnostics || null,
            gridDiff: result.gridDiff || null,
            parserVersion: result.parserVersion || result.meta?.parser_version || null,
            scenarioVersion: result.scenarioVersion ?? result.meta?.scenario_version ?? null,
            validationReport: result.validationReport || null,
        };
    }

    return {
        ok: true,
        rule: result.rule || null,
        snapshotId: result.snapshotId || null,
        parsePreview: result.parsePreview || null,
        compareResult: null,
        assistantMessage:
            result.assistantMessage ||
            `Разобрала **${result.parsePreview?.rowCount || 0}** строк (${scenarioDisplayName(scenarioId)}).`,
        warnings: result.warnings || [],
        layoutMeta: result.layoutMeta || routed.layoutMeta,
        sheetNames: [],
        sheetName: null,
        needsScenarioChoice: Boolean(result.needsScenarioChoice),
        needsConfirm: Boolean(result.needsConfirm),
        scenarioId,
        scenarioName: result.scenarioName || scenarioDisplayName(scenarioId),
        confidence: result.confidence ?? routed.confidence,
        sourceKind: result.sourceKind || routed.sourceKind,
        candidates: result.candidates || routed.candidates || [],
        treeSample: [],
        pendingQuestions: result.needsConfirm
            ? [{ id: 'confirm_parse', text: 'Подтверди результат парсинга или уточни поля в чате.' }]
            : result.needsScenarioChoice
              ? [{ id: 'pdf_kind_choice', text: 'Выбери тип PDF-документа.' }]
              : [],
        currentQuestion: result.needsConfirm
            ? {
                  id: 'confirm_parse',
                  promptTemplate:
                      result.assistantMessage ||
                      'Подтверди результат парсинга или уточни поля в чате.',
              }
            : result.needsScenarioChoice
              ? {
                    id: 'pdf_kind_choice',
                    promptTemplate:
                        result.assistantMessage ||
                        'Не могу однозначно определить тип PDF. Выбери кнопкой ниже.',
                }
              : null,
        sessionState: {
            step: result.needsConfirm ? 'confirm' : result.needsScenarioChoice ? 'pick_scenario' : 'ready',
            profileId: routed.profileId || 'pavel',
            scenarioId,
        },
        meta: result.meta || null,
        engine: result.engine,
        scenarioResolution: result.scenarioResolution || null,
        gridDiagnostics: result.gridDiagnostics || null,
        gridDiff: result.gridDiff || null,
        parserVersion: result.parserVersion || result.meta?.parser_version || null,
        scenarioVersion: result.scenarioVersion ?? result.meta?.scenario_version ?? null,
        validationReport: result.validationReport || null,
    };
}

async function respondUniversalPdfAutostart(
    res,
    { sourceFile, routed, projectId, userMessage, chatSessionId, orchestratorAnswers }
) {
    const session = await buildUniversalAutostartResponse(sourceFile, routed, {
        projectId,
        userMessage: userMessage || '',
        orchestratorAnswers: orchestratorAnswers || {},
    });
    if (!session.ok) {
        if (session.delegateDepo) {
            return res.status(422).json({
                error: 'PDF ДЕПО: загрузите через раздел ОПИФ (Любовь) или напиши «депо» в задаче.',
            });
        }
        return res.status(422).json({ error: (session.errors || ['Ошибка парсинга PDF']).join('; ') });
    }

    const body = {
        ok: true,
        rule: session.rule,
        snapshotId: session.snapshotId,
        parsePreview: session.parsePreview,
        assistantMessage: session.assistantMessage,
        warnings: session.warnings,
        layoutAnalysis: session.layoutMeta,
        needsScenarioChoice: Boolean(session.needsScenarioChoice),
        needsConfirm: session.needsConfirm,
        scenarioId: session.scenarioId,
        scenarioName: session.scenarioName,
        confidence: session.confidence,
        sourceKind: session.sourceKind,
        candidates: session.candidates || [],
        meta: session.meta,
        pendingQuestions: session.pendingQuestions,
        currentQuestion: session.currentQuestion,
        sessionState: session.sessionState,
        engine: session.engine,
        userMessage,
        multiSheet: session.multiSheet || false,
        multiTable: session.multiTable || false,
        snapshots: session.snapshots || null,
        sheetNames: session.sheetNames || null,
        validationReport: session.validationReport || null,
        gridDiagnostics: session.gridDiagnostics || null,
        scenarioResolution: session.scenarioResolution || null,
        sourceFileName: sourceFile.originalname || sourceFile.name || null,
        sourceInboxPath: sourceFile.relativePath || null,
    };

    safeResJson(res, body);

    if (!chatSessionId) return;

    const runSideEffects = async () => {
        if (session.snapshotId) {
            if (session.multiSheet && Array.isArray(session.snapshots)) {
                for (const snap of session.snapshots) {
                    if (!snap.snapshotId) continue;
                    await maybeLinkSnapshotToChat({
                        chatSessionId,
                        snapshotId: snap.snapshotId,
                        projectId,
                        label: snap.label || snap.sheetName || sourceFile.originalname,
                    });
                }
            } else {
                await maybeLinkSnapshotToChat({
                    chatSessionId,
                    snapshotId: session.snapshotId,
                    projectId,
                    label: sourceFile.originalname,
                });
            }
        }
        if (session.assistantMessage) {
            await logChatExchange({
                chatSessionId,
                projectId,
                snapshotId: session.snapshotId,
                userMessage: userMessage || '(старт парса)',
                assistantMessage: session.assistantMessage,
            });
        }
    };
    const side = () => runSideEffects().catch((e) => console.error('[pdf-autostart-side]', e.message));
    if (res.writableFinished) side();
    else res.once('finish', side);
}

async function applyStructureAutostartToBatch({
    pool,
    sourceFile,
    targetFile,
    sheetName,
    projectId,
    savedRules,
    scenarioId,
    orchestratorAnswers,
    userMessage,
    chatSessionId,
    parsePlan,
    res,
}) {
    if (
        !shouldUseStructureOrchestrator({
            fileName: sourceFile.originalname,
            scenarioId,
            orchestratorAnswers,
        })
    ) {
        return null;
    }

    console.log('[batch-start] structure orchestrator', fileNameOf(sourceFile), sheetName || '(default sheet)');
    const structureStarted = Date.now();
    const parsed = await runExcelStructureAutostart({
        pool,
        file: sourceFile,
        targetFile,
        sheetName,
        projectId,
        savedRules,
    });

    if (parsed.ok) {
        const body = buildStructureAutostartResponse(parsed, {
            userMessage,
            parsePlan,
            fileName: fileNameOf(sourceFile),
        });
        if (chatSessionId && parsed.snapshotId) {
            await maybeLinkSnapshotToChat({
                chatSessionId,
                snapshotId: parsed.snapshotId,
                projectId,
                label: [fileNameOf(sourceFile), parsed.sheetName, parsed.rowCount]
                    .filter((x) => x != null && x !== '')
                    .join(' · '),
            });
        }
        const chatLogFn =
            chatSessionId && body.assistantMessage
                ? () =>
                      logChatExchange({
                          chatSessionId,
                          projectId,
                          snapshotId: parsed.snapshotId,
                          userMessage: userMessage || '(старт парса)',
                          assistantMessage: body.assistantMessage,
                      })
                : null;
        console.log(
            '[batch-start] structure ok',
            parsed.structureId,
            parsed.rowCount,
            'rows',
            `in ${Date.now() - structureStarted}ms`
        );
        safeResJsonAndLogChat(
            res,
            { ...body, userMessage, parsePlan: parsePlan || null, staged: false },
            chatLogFn
        );
        return true;
    }

    if (parsed.refused || parsed.skipped) {
        const status = parsed.refused ? 422 : 422;
        res.status(status).json(
            buildStructureRefusalHttpBody(parsed, {
                parsePlan,
                fileName: fileNameOf(sourceFile),
            })
        );
        return true;
    }

    res.status(422).json({
        ok: false,
        error: parsed.assistantMessage || `Не удалось разобрать лист: ${parsed.reason}`,
        triedProfiles: parsed.triedProfiles,
    });
    return true;
}

async function parseMultipleExcelWorkbooksFromBatch({
    pool,
    files,
    targetFile,
    projectId,
    savedRules,
    userMessage,
    chatSessionId,
    parsePlan,
    res,
}) {
    const excelFiles = (files || []).filter(
        (f) => detectSourceKind(fileNameOf(f)) === 'excel' && f.buffer
    );
    if (!excelFiles.length) {
        return res.status(422).json({
            error: 'В выборе нет Excel для разбора. Уточни файл/папку или напиши «депо»/«брокер» для PDF/OPIF.',
        });
    }

    const parsed = [];
    const skipped = [];
    for (const file of excelFiles) {
        const structureStarted = Date.now();
        const result = await runExcelStructureAutostart({
            pool,
            file,
            targetFile,
            sheetName: null,
            projectId,
            savedRules,
        });
        if (result?.ok) {
            parsed.push({ file, result });
            if (chatSessionId && result.snapshotId) {
                await maybeLinkSnapshotToChat({
                    chatSessionId,
                    snapshotId: result.snapshotId,
                    projectId,
                    label: [fileNameOf(file), result.sheetName, result.rowCount]
                        .filter((x) => x != null && x !== '')
                        .join(' · '),
                });
            }
            console.log(
                '[batch-start] multi-workbook ok',
                fileNameOf(file),
                result.rowCount,
                'rows',
                `in ${Date.now() - structureStarted}ms`
            );
        } else {
            skipped.push({
                fileName: fileNameOf(file),
                reason: result?.assistantMessage || result?.reason || 'unknown_structure',
            });
        }
    }

    if (!parsed.length) {
        return res.status(422).json({
            error: `Не разобрала ни один Excel из ${excelFiles.length} в выборе.`,
            skipped,
        });
    }

    const snapshots = parsed.map(({ file, result }) => ({
        snapshotId: result.snapshotId,
        sheetName: result.sheetName,
        label: `${fileNameOf(file)} · ${result.rowCount}`,
        rowCount: result.rowCount,
        scenarioId: result.scenarioId,
        scenarioName: result.scenarioName || scenarioDisplayName(result.scenarioId),
        validationReport: result.validationReport || null,
    }));

    const primary = parsed[0].result;
    const assistantMessage = [
        `Разобрала **${parsed.length}** из **${excelFiles.length}** Excel в выборке.`,
        skipped.length
            ? `Пропустила: ${skipped.map((s) => `${s.fileName} (${s.reason})`).join('; ')}.`
            : '',
        parsePlan?.summary ? `\n📋 План: ${parsePlan.summary}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    if (chatSessionId) {
        await logChatExchange({
            chatSessionId,
            projectId,
            snapshotId: primary.snapshotId,
            userMessage,
            assistantMessage,
        });
    }

    return safeResJson(res, {
        ok: true,
        multiSheet: true,
        snapshots,
        sheetNames: parsed.map(({ result }) => result.sheetName).filter(Boolean),
        snapshotId: primary.snapshotId,
        parsePreview: primary.parsePreview,
        scenarioId: primary.scenarioId,
        scenarioName: primary.scenarioName || scenarioDisplayName(primary.scenarioId),
        rule: primary.rule,
        layoutAnalysis: primary.layoutMeta,
        structureId: primary.structureId,
        structure: primary.structure,
        validationReport: primary.validationReport || null,
        warnings: skipped.map((s) => `${s.fileName}: ${s.reason}`),
        assistantMessage,
        skippedWorkbooks: skipped,
        needsUserInput: false,
        needsScenarioChoice: false,
        previewIsTentative: false,
        userMessage,
        parsePlan: parsePlan || null,
        staged: false,
        fromInbox: true,
    });
}

function isPdfLikeFile(file) {
    const kind = detectSourceKind(fileNameOf(file));
    return kind === 'pdf' || kind === 'image_scan';
}

/** @deprecated use isPdfLikeFile */
function isScanLikeFile(file) {
    return isPdfLikeFile(file);
}

async function parseMultiplePdfDocumentsFromBatch({
    pool,
    files,
    projectId,
    userMessage,
    chatSessionId,
    parsePlan,
    res,
    orchestratorAnswers,
}) {
    const pdfFiles = (files || []).filter((f) => isPdfLikeFile(f) && f.buffer);
    if (!pdfFiles.length) {
        return res.status(422).json({
            error: 'В выборе нет PDF для разбора.',
        });
    }

    const requestedHeaders = parseRequestedTableColumns(userMessage);
    const allSnapshots = [];
    const allRows = [];
    const skipped = [];
    let headers = requestedHeaders.length > 0 ? [...requestedHeaders] : [];
    let primaryScenarioId = 'pdf_extracted';
    let anyMultiSheet = false;

    for (let i = 0; i < pdfFiles.length; i++) {
        const file = pdfFiles[i];
        const name = fileNameOf(file);
        try {
            const result = await parseUniversal({
                pool,
                file,
                projectId,
                userMessage,
                orchestratorAnswers: orchestratorAnswers || {},
            });
            if (result.scenarioId) primaryScenarioId = result.scenarioId;

            if (result.multiSheet && Array.isArray(result.snapshots) && result.snapshots.length) {
                anyMultiSheet = true;
                for (const snap of result.snapshots) {
                    const sectionLabel = snap.sheetName || snap.label || 'таблица';
                    const entry = {
                        snapshotId: snap.snapshotId,
                        sheetName: `${name} — ${sectionLabel}`,
                        label: `${name} · ${sectionLabel} · ${snap.rowCount}`,
                        rowCount: snap.rowCount,
                        scenarioId: snap.scenarioId || result.scenarioId,
                        scenarioName:
                            snap.scenarioName ||
                            scenarioDisplayName(snap.scenarioId || result.scenarioId),
                        parsePreview: snap.parsePreview,
                        sectionId: snap.sectionId,
                    };
                    allSnapshots.push(entry);
                    if (chatSessionId && snap.snapshotId) {
                        await maybeLinkSnapshotToChat({
                            chatSessionId,
                            snapshotId: snap.snapshotId,
                            projectId,
                            label: entry.label,
                        });
                    }
                }
                continue;
            }

            const previewRows = result.parsePreview?.rows || [];
            const rowCount =
                result.parsePreview?.rowCount ?? previewRows.length ?? 0;

            if (result.snapshotId && rowCount > 0) {
                if (primaryScenarioId === 'broker_pdf') {
                    allSnapshots.push({
                        snapshotId: result.snapshotId,
                        sheetName: name,
                        label: `${name} · ${rowCount}`,
                        rowCount,
                        scenarioId: result.scenarioId,
                        scenarioName:
                            result.scenarioName || scenarioDisplayName(result.scenarioId),
                        parsePreview: result.parsePreview,
                    });
                    if (chatSessionId) {
                        await maybeLinkSnapshotToChat({
                            chatSessionId,
                            snapshotId: result.snapshotId,
                            projectId,
                            label: `${name} · ${rowCount}`,
                        });
                    }
                    continue;
                }

                for (let j = 0; j < previewRows.length; j++) {
                    const row = { ...previewRows[j] };
                    const onlyUserCols =
                        requestedHeaders.length > 0 &&
                        (result.scenarioId === 'document_scan' ||
                            primaryScenarioId === 'document_scan');
                    if (!onlyUserCols) {
                        row.source_file = previewRows[j].source_file || name;
                        row['№'] = previewRows[j]['№'] || String(allRows.length + 1);
                    }
                    allRows.push(row);
                }
                if (!headers.length && result.parsePreview.headers?.length) {
                    headers = [...result.parsePreview.headers];
                    if (
                        !headers.includes('source_file') &&
                        !(requestedHeaders.length > 0 && result.scenarioId === 'document_scan')
                    ) {
                        headers.push('source_file');
                    }
                }
            } else {
                skipped.push({
                    fileName: name,
                    reason: result.assistantMessage || (result.errors || ['нет строк']).join('; '),
                });
            }
        } catch (err) {
            skipped.push({ fileName: name, reason: err.message });
        }
    }

    const useSnapshotTabs =
        primaryScenarioId === 'broker_pdf' ||
        (primaryScenarioId !== 'document_scan' && anyMultiSheet) ||
        (primaryScenarioId !== 'document_scan' && allSnapshots.length > 1);

    if (useSnapshotTabs && allSnapshots.length) {
        const primary = allSnapshots[0];
        const labelPrefix =
            primaryScenarioId === 'broker_pdf'
                ? 'Брокер PDF'
                : primaryScenarioId === 'document_scan'
                  ? 'Сканы'
                  : 'PDF';

        const assistantMessage = [
            `${labelPrefix}: **${allSnapshots.length}** таблиц из **${pdfFiles.length}** файл(ов).`,
            skipped.length
                ? `Пропустила: ${skipped.map((s) => `${s.fileName} (${s.reason})`).join('; ')}.`
                : '',
            parsePlan?.summary ? `\n📋 План: ${parsePlan.summary}` : '',
        ]
            .filter(Boolean)
            .join('\n');

        if (chatSessionId) {
            await logChatExchange({
                chatSessionId,
                projectId,
                snapshotId: primary.snapshotId,
                userMessage,
                assistantMessage,
            });
        }

        return safeResJson(res, {
            ok: true,
            multiSheet: true,
            multiTable: primaryScenarioId === 'broker_pdf',
            snapshots: allSnapshots,
            sheetNames: allSnapshots.map((s) => s.sheetName).filter(Boolean),
            snapshotId: primary.snapshotId,
            parsePreview: primary.parsePreview,
            scenarioId: primaryScenarioId,
            scenarioName: scenarioDisplayName(primaryScenarioId),
            sourceKind: 'pdf',
            engine: primaryScenarioId === 'broker_pdf' ? 'pdf_broker_sections' : 'pdf_universal',
            needsConfirm: skipped.length > 0,
            warnings: skipped.map((s) => `${s.fileName}: ${s.reason}`),
            assistantMessage,
            skippedPdfs: skipped,
            userMessage,
            parsePlan: parsePlan || null,
            staged: false,
            fromInbox: true,
        });
    }

    if (!allRows.length) {
        return res.status(422).json({
            error: `Не разобрала ни один PDF из ${pdfFiles.length}.`,
            skipped,
        });
    }

    if (!headers.length) {
        headers = [...new Set(allRows.flatMap((r) => Object.keys(r)))];
    }
    for (const h of headers) {
        for (const row of allRows) {
            if (row[h] == null) row[h] = '';
        }
    }

    const snapshotId = await snapshotStore.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: `pdf_${pdfFiles.length}files`,
        sheetName: null,
        scenarioId: primaryScenarioId,
        headers,
        status: 'parsing',
    });
    const rowCount = await snapshotStore.importParsedRows(snapshotId, headers, allRows);

    const labelPrefix =
        primaryScenarioId === 'broker_pdf'
            ? 'Брокер PDF'
            : primaryScenarioId === 'document_scan'
              ? 'Сканы'
              : 'PDF';

    const assistantMessage = [
        `${labelPrefix}: **${allRows.length}** строк из **${pdfFiles.length}** файл(ов).`,
        skipped.length
            ? `Пропустила: ${skipped.map((s) => `${s.fileName} (${s.reason})`).join('; ')}.`
            : '',
        requestedHeaders.length
            ? `Колонки: ${requestedHeaders.join(', ')}.`
            : '',
        parsePlan?.summary ? `\n📋 План: ${parsePlan.summary}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    if (chatSessionId) {
        await maybeLinkSnapshotToChat({
            chatSessionId,
            snapshotId,
            projectId,
            label: `${labelPrefix} · ${rowCount}`,
        });
        await logChatExchange({
            chatSessionId,
            projectId,
            snapshotId,
            userMessage,
            assistantMessage,
        });
    }

    return safeResJson(res, {
        ok: true,
        snapshotId,
        parsePreview: {
            headers,
            rows: allRows.slice(0, PREVIEW_ROWS_CLIENT),
            rowCount,
        },
        scenarioId: primaryScenarioId,
        scenarioName: scenarioDisplayName(primaryScenarioId),
        sourceKind: 'pdf',
        engine: primaryScenarioId === 'document_scan' ? 'document_scan_llm' : 'pdf_universal',
        needsConfirm: skipped.length > 0 || rowCount < pdfFiles.length,
        warnings: skipped.map((s) => `${s.fileName}: ${s.reason}`),
        assistantMessage,
        skippedPdfs: skipped,
        userMessage,
        parsePlan: parsePlan || null,
        staged: false,
        fromInbox: true,
    });
}

async function parseMultipleScanDocumentsFromBatch(ctx) {
    return parseMultiplePdfDocumentsFromBatch(ctx);
}

async function runMartinSession({
    file,
    targetFile,
    layoutMeta,
    currentRule,
    userMessage,
    messages,
    isFirstPass,
    scenarioId: scenarioIdParam,
    orchestratorAnswers,
    savedRules = [],
    projectId = null,
    routerResult = null,
}) {
    let layoutMetaLocal = layoutMeta || null;
    let routed = routerResult;
    if (file && !routed) {
        routed = await resolveUpload({
            buffer: file.buffer,
            fileName: file.originalname,
            sheetName: layoutMetaLocal?.sheetName,
            targetBuffer: targetFile?.buffer,
            orchestratorAnswers: orchestratorAnswers || {},
        });
        if (routed.route === 'error') {
            return { ok: false, errors: routed.errors || ['Не удалось определить сценарий'] };
        }
        if (routed.route === 'text') {
            return {
                ok: false,
                errors: ['Текстовый файл обрабатывается через buildText1cAutostartResponse'],
            };
        }
        if (!layoutMetaLocal && routed.layoutMeta) {
            layoutMetaLocal = routed.layoutMeta;
        }
    }

    function ensureOsvCatalogFor76(meta, scenarioId) {
        if (scenarioId !== 'os_76_account_card' || !file?.buffer || !meta) return meta;
        const sheet =
            meta.sheetName ||
            pickPreferredSheet(meta.sheetNames || [], meta.sheetName);
        const rebuilt = buildColumnCatalog(file.buffer, sheet, { layout_type: 'hierarchy_osv' });
        return { ...meta, sheetName: sheet || meta.sheetName, column_catalog: rebuilt.catalog };
    }
    const columnCatalog = layoutMetaLocal?.column_catalog || null;

    let target = null;
    if (targetFile?.buffer) {
        target = loadTargetRows(targetFile.buffer);
    }

    if (layoutMetaLocal) {
        orchestratorAnswers = applyAutostartDefaults(layoutMetaLocal, orchestratorAnswers || {});
    }

    const plan = buildSessionPlan(layoutMetaLocal, target, currentRule, {
        scenarioIdParam,
        userMessage,
        answers: orchestratorAnswers || {},
        savedRules,
    });

    const treeInf = layoutMetaLocal?.tree_inference;
    const routedScenario =
        scenarioIdParam ||
        routed?.scenarioId ||
        orchestratorAnswers?.scenarioId ||
        null;
    const mustConfirmTree =
        routed?.needsTreeConfirm ??
        shouldRequireTreeConfirm(layoutMetaLocal, routedScenario || 'os_01_flat', orchestratorAnswers);

    const smartDialog = isSmartDialogEnabled();
    const deferParseForQuestions =
        (plan.needsUserInput || mustConfirmTree) && (!isFirstPass || smartDialog);

    // Smart dialog: на первом проходе — черновик + вопрос, без commit в БД
    if (deferParseForQuestions) {
        const q = plan.currentQuestion;
        const isPickScenario = q?.id === 'pick_scenario';
        const isPickTree = q?.id === 'pick_tree_flatten' || mustConfirmTree;
        const awaitingConfirmation = isPickScenario || isPickTree || mustConfirmTree;
        const candidates = isPickScenario
            ? q.options.map((o) => o.value)
            : plan.pendingQuestions
                  .find((x) => x.id === 'pick_scenario')
                  ?.options?.map((o) => o.value) || ['os_01_flat', 'os_01_hierarchy'];

        const detected = detectSuggestedScenario(layoutMetaLocal, target);
        const previewScenario =
            routedScenario ||
            (isAccountCard76(layoutMetaLocal) ? 'os_76_account_card' : null) ||
            detected.scenarioId ||
            (layoutMetaLocal?.tree_inference?.profileKey === 'os_76_card'
                ? 'os_76_account_card'
                : 'os_01_hierarchy');

        layoutMetaLocal = ensureOsvCatalogFor76(layoutMetaLocal, previewScenario);
        let rulePreview = applyScenario(previewScenario, layoutMetaLocal, target);

        if (userMessage && isTreeIntentMessage(userMessage)) {
            const llmTree = await planTreeRuleWithLlm({
                message: userMessage,
                treeInference: layoutMetaLocal?.tree_inference,
                layoutMeta: layoutMetaLocal,
                baseRule: rulePreview,
            });
            if (llmTree.ok) {
                rulePreview = llmTree.rule;
                if (llmTree.proposal?.scenario_hint) {
                    const hinted = llmTree.proposal.scenario_hint;
                    if (hinted && hinted !== 'null') rulePreview = applyScenario(hinted, layoutMetaLocal, target);
                }
            }
        }

        let parsePreviewTentative = null;
        let snapshotIdTentative = null;
        let warningsPreview = [];
        if (file && rulePreview) {
            if (awaitingConfirmation) {
                const previewResult = withTempFile(file.buffer, file.originalname, (tmpPath) =>
                    runParsePreview(tmpPath, rulePreview, 50)
                );
                if (previewResult.ok) {
                    parsePreviewTentative = {
                        headers: previewResult.headers,
                        rows: previewResult.rows,
                        rowCount: previewResult.rowCount,
                    };
                    warningsPreview = previewResult.warnings || [];
                } else {
                    warningsPreview = previewResult.errors || [];
                }
            } else {
                const imported = await importParseFromFile(file, rulePreview, {
                    projectId,
                    scenarioId: previewScenario,
                    sheetName: layoutMetaLocal?.sheetName,
                });
                snapshotIdTentative = imported.snapshotId;
                if (imported.ok) {
                    parsePreviewTentative = imported.parsePreview;
                    warningsPreview = imported.warnings;
                } else {
                    warningsPreview = imported.warnings;
                }
            }
        }

        const treeSample = getTreeSample(layoutMetaLocal);
        const syntheticTreeQuestion =
            mustConfirmTree && q?.id !== 'pick_tree_flatten'
                ? {
                      id: 'pick_tree_flatten',
                      promptTemplate:
                          `Вижу дерево:\n**${(treeInf.levelLabels || []).join(' → ')}**\n\n` +
                          treeInf.examples
                              .slice(0, 3)
                              .map(
                                  (e) =>
                                      e.text ||
                                      [...(e.path || []), e.leaf_name].filter(Boolean).join(' → ')
                              )
                              .join('\n') +
                          '\n\nРазвернуть в плоскую таблицу (каждый договор — строка, предки в колонках)?',
                      options: [
                          { value: 'confirm', label: 'Да, развернуть так' },
                          { value: 'scenario:os_08_osv', label: 'Нет, это ОСВ 08' },
                      ],
                  }
                : null;
        const effectiveQuestion = syntheticTreeQuestion || q;
        const fallbackMessage = isPickScenario
            ? `${buildScenarioChoiceMessage(layoutMetaLocal)}\n\nПоказала **черновик** (${previewScenario}). Подтверди сценарий кнопкой — после этого запишу в БД.`
            : isPickTree
              ? `${effectiveQuestion?.promptTemplate || ''}\n\nПоказала **черновик** таблицы. Нажми «Да, развернуть так» — тогда полный парс в БД.`
              : effectiveQuestion?.promptTemplate;

        const assistantMessage = shouldUseLlmReply()
            ? await generateMartinReply({
                  messages: messages || [],
                  context: buildLlmContext({
                      preview: parsePreviewTentative,
                      compare: null,
                      rule: rulePreview,
                      layoutMeta: layoutMetaLocal,
                      userMessage,
                      scenarioId: previewScenario,
                      needsScenarioChoice: isPickScenario,
                      awaitingTreeConfirm: isPickTree,
                      pendingQuestion: effectiveQuestion,
                  }),
                  fallbackMessage,
              })
            : fallbackMessage;

        return {
            ok: true,
            needsScenarioChoice: isPickScenario,
            awaitingTreeConfirm: isPickTree,
            scenarioId: previewScenario,
            previewIsTentative: true,
            candidates,
            treeSample,
            assistantMessage,
            layoutMeta: layoutMetaLocal,
            columnCatalog,
            rule: rulePreview,
            parsePreview: parsePreviewTentative,
            snapshotId: snapshotIdTentative,
            compareResult: null,
            warnings: warningsPreview,
            pendingQuestions: syntheticTreeQuestion
                ? [syntheticTreeQuestion, ...plan.pendingQuestions]
                : plan.pendingQuestions,
            currentQuestion: effectiveQuestion,
            sessionState: plan.sessionState,
            treeInference: treeInf,
        };
    }

    const detectedFinal = detectSuggestedScenario(layoutMetaLocal, target);
    let scenarioId =
        routedScenario ||
        (layoutMetaLocal?.recommended?.profile_hint === 'uk_card' ? 'uk_card' : null) ||
        (plan.sessionState?.profileId === 'uk_card' ? 'uk_card' : null) ||
        (orchestratorAnswers?.pick_tree_flatten === 'confirm' &&
        layoutMetaLocal?.tree_inference?.profileKey === 'os_76_card'
            ? 'os_76_account_card'
            : null) ||
        (isAccountCard76(layoutMetaLocal) ? 'os_76_account_card' : null) ||
        plan.sessionState?.scenarioId ||
        detectedFinal.scenarioId ||
        'os_01_flat';
    layoutMetaLocal = applyOrchestratorToLayoutMeta(layoutMetaLocal, plan.sessionState);
    layoutMetaLocal = ensureOsvCatalogFor76(layoutMetaLocal, scenarioId);

    let rule = applyScenario(scenarioId, layoutMetaLocal, target);

    // Composite-cell extraction -> добавляем в rule.columns source.type=composite_cell
    if (rule && plan.sessionState?.compositeColumn != null && Array.isArray(plan.sessionState?.compositeExtracts) && plan.sessionState.compositeExtracts.length) {
        const compositeColumn = Number(plan.sessionState.compositeColumn);
        const extracts = plan.sessionState.compositeExtracts;

        const existingTargets = new Set((rule.columns || []).map((c) => c.target));
        const addCols = [];

        for (const f of extracts) {
            if (f === 'inventory_number') {
                const target = 'Инвентарный номер';
                if (!existingTargets.has(target)) {
                    addCols.push({
                        target,
                        source: {
                            type: 'composite_cell',
                            column: compositeColumn,
                            extract: { pattern: '\\d{8,}', group: 0 },
                        },
                    });
                }
            }
            if (f === 'date_ddmmyyyy') {
                const target = 'Дата';
                if (!existingTargets.has(target)) {
                    addCols.push({
                        target,
                        source: {
                            type: 'composite_cell',
                            column: compositeColumn,
                            extract: { pattern: '\\d{2}\\.\\d{2}\\.\\d{4}', transform: 'date_ddmmyyyy' },
                        },
                    });
                }
            }
        }

        if (addCols.length) {
            rule.columns = [...rule.columns, ...addCols];
        }
    }

    if (userMessage) {
        if (isTreeIntentMessage(userMessage)) {
            const llmTree = await planTreeRuleWithLlm({
                message: userMessage,
                treeInference: layoutMetaLocal?.tree_inference,
                layoutMeta: layoutMetaLocal,
                baseRule: rule,
            });
            if (llmTree.ok) {
                rule = llmTree.rule;
                if (llmTree.proposal?.scenario_hint && llmTree.proposal.scenario_hint !== 'null') {
                    scenarioId = llmTree.proposal.scenario_hint;
                    rule = applyScenario(scenarioId, layoutMetaLocal, target);
                    Object.assign(rule.hierarchy || {}, llmTree.rule.hierarchy || {});
                }
            }
        }
        rule = applyV2HintsFromUserMessage(rule, userMessage, layoutMetaLocal, columnCatalog);
        const fromMsg = resolveScenarioFromMessage(userMessage, Boolean(target?.headers?.length));
        if (fromMsg && fromMsg !== scenarioId) {
            scenarioId = fromMsg;
            rule = applyScenario(scenarioId, layoutMetaLocal, target);
            rule = applyV2HintsFromUserMessage(rule, userMessage, layoutMetaLocal, columnCatalog);
        }
    }

    const targetUsed = Boolean(target?.headers?.length) && scenarioId === 'from_target';
    if (targetUsed && rule) {
        rule = applyTargetToRule(rule, target, columnCatalog);
    }

    let validated = validateRuleV2(rule);
    if (!validated.ok && userMessage && shouldBootstrapWithLlm(layoutMetaLocal, userMessage, true)) {
        const llmRule = await bootstrapRuleWithLlm({
            layoutMeta: layoutMetaLocal,
            userMessage,
            baseRule: rule,
        });
        if (llmRule.ok) {
            rule = llmRule.rule;
            if (targetUsed) rule = applyTargetToRule(rule, target, columnCatalog);
            validated = validateRuleV2(rule);
        }
    }
    if (!validated.ok && userMessage) {
        rule = bootstrapRuleFromUserMessage(userMessage, layoutMetaLocal);
        if (targetUsed) rule = applyTargetToRule(rule, target, columnCatalog);
        validated = validateRuleV2(rule);
    }
    if (!validated.ok) {
        return {
            ok: false,
            errors: validated.errors,
            rule,
            layoutMeta: layoutMetaLocal,
        };
    }

    rule = validated.rule;
    const ruleDiff = computeRuleDiff(currentRule, rule);
    let parsePreview = null;
    let snapshotId = null;
    let warnings = [];
    let compareResult = null;
    let ukSanityQuestion = null;

    if (file) {
        const imported = await importParseFromFile(file, rule, {
            projectId,
            scenarioId,
            sheetName: layoutMetaLocal?.sheetName,
        });
        snapshotId = imported.snapshotId;
        if (imported.ok) {
            parsePreview = imported.parsePreview;
            warnings = imported.warnings;
            if (scenarioId === 'uk_card' && parsePreview?.rows?.length) {
                const sanity = checkUkParseSanity(parsePreview.rows, layoutMetaLocal?.uk_probe || {});
                if (sanity.warnings?.length) {
                    warnings = [...warnings, ...sanity.warnings];
                }
                const qtyAnswered =
                    plan.sessionState?.quantityColumn != null ||
                    orchestratorAnswers?.quantityColumn != null ||
                    orchestratorAnswers?.pick_uk_quantity_column != null;
                if (
                    sanity.issues?.includes('quantity_like_balance') &&
                    sanity.suggestQuantityColumn != null &&
                    !qtyAnswered
                ) {
                    const probe = layoutMetaLocal?.uk_probe || {};
                    const qtyOpts = probe.quantity_options?.length
                        ? probe.quantity_options
                        : [
                              { index: 7, letter: 'H', sample: '' },
                              { index: 8, letter: 'I', sample: '' },
                          ];
                    ukSanityQuestion = {
                        id: 'pick_uk_quantity_column',
                        promptTemplate:
                            'Количество похоже на сальдо, а не на штуки. Где в строках «Кол.» правильная колонка?',
                        options: qtyOpts.map((o) => ({
                            value: String(o.index),
                            label: `Колонка ${o.letter}${o.sample ? ` — пример: ${o.sample}` : ''}${o.median != null ? ` (медиана ${o.median})` : ''}`,
                        })),
                    };
                }
            }
            if (target && snapshotId) {
                const compareRows = await getSnapshotRowsForCompare(snapshotId, 5000);
                if (compareRows?.rows?.length) {
                    compareResult = comparePreviewToTarget(compareRows, target);
                }
            }
        } else {
            warnings = imported.warnings;
        }
    }

    const warnSuffix =
        warnings.length > 0 ? `\n\n⚠ ${warnings.join('\n⚠ ')}` : '';

    const fallbackMessage =
        buildTemplateMessage({
            preview: parsePreview,
            compare: compareResult,
            rule,
            layoutMeta: layoutMetaLocal,
            isFirstPass,
            ruleDiff,
            targetUsed,
            scenarioId,
            needsScenarioChoice: false,
        }) + warnSuffix;

    const assistantMessage = await generateMartinReply({
        messages: messages || [],
        context: buildLlmContext({
            preview: parsePreview,
            compare: compareResult,
            rule,
            layoutMeta: layoutMetaLocal,
            ruleDiff,
            userMessage,
            scenarioId,
            needsScenarioChoice: false,
        }),
        fallbackMessage,
    });

    return {
        ok: true,
        needsScenarioChoice: false,
        needsUserInput: Boolean(ukSanityQuestion),
        scenarioId,
        rule,
        ruleDiff,
        parsePreview,
        snapshotId,
        warnings,
        compareResult,
        assistantMessage,
        layoutMeta: layoutMetaLocal,
        columnCatalog,
        targetUsed,
        treeSample: getTreeSample(layoutMetaLocal),
        pendingQuestions: ukSanityQuestion ? [ukSanityQuestion] : [],
        currentQuestion: ukSanityQuestion,
        sessionState: plan.sessionState,
    };
}

async function processAiChat({
    profileFamily,
    messages,
    currentRule,
    file,
    sheetName,
    layoutAnalysis,
    targetFile,
    scenarioId,
    orchestratorAnswers,
    projectId,
    chatSessionId,
}) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return { status: 400, body: { error: 'Нужен хотя бы один message в истории' } };
    }
    if (!file) {
        return { status: 400, body: { error: 'Нужен файл' } };
    }

    const sourceKind = detectSourceKind(file.originalname || file.name || '');
    if (sourceKind !== 'excel') {
        return {
            status: 400,
            body: {
                error:
                    'PDF и сканы парсятся из **хранилища**: выбери файл через 📎 слева и напиши задачу (например «создай таблицу: …»).',
            },
        };
    }

    let excelMeta = null;
    try {
        excelMeta = analyzeExcelBuffer(file.buffer, sheetName || undefined);
    } catch (e) {
        return { status: 400, body: { error: 'Не удалось прочитать Excel: ' + e.message } };
    }

    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    let savedRules = [];
    if (projectId) savedRules = await fetchSavedRulesByProject(projectId);

    let toolExchange = null;
    if (isToolsEnabled()) {
        try {
            toolExchange = await processAiChatWithTools({
                messages,
                context: {
                    scenarioId,
                    orchestratorAnswers: orchestratorAnswers || {},
                    layoutMeta: layoutAnalysis,
                    currentQuestion: orchestratorAnswers?.currentQuestion || null,
                    parsePreview: orchestratorAnswers?.parsePreview || null,
                    targetBuffer: targetFile?.buffer || null,
                },
                maxSteps: 2,
            });
            if (toolExchange?.context?.orchestratorAnswers) {
                orchestratorAnswers = {
                    ...(orchestratorAnswers || {}),
                    ...toolExchange.context.orchestratorAnswers,
                };
            }
            if (toolExchange?.context?.filePrefix) {
                orchestratorAnswers = {
                    ...orchestratorAnswers,
                    filePrefix: toolExchange.context.filePrefix,
                };
            }
        } catch (err) {
            console.warn('martin_tools:', err.message);
        }
    }

    const sheetForSession = sheetName || layoutAnalysis?.sheetName || excelMeta?.sheetName;
    let layoutForSession = layoutAnalysis;
    const mustRebuildLayout =
        !layoutForSession ||
        (sheetForSession && layoutForSession.sheetName !== sheetForSession) ||
        orchestratorAnswers?.pick_tree_flatten === 'confirm';
    if (mustRebuildLayout) {
        layoutForSession = analyzeLayout(file.buffer, sheetForSession);
    }

    const session = await runMartinSession({
        file,
        targetFile,
        layoutMeta: layoutForSession,
        currentRule,
        userMessage: lastUser?.content || '',
        messages,
        isFirstPass: false,
        scenarioId,
        orchestratorAnswers,
        savedRules,
        projectId,
    });

    if (!session.ok) {
        return {
            status: 422,
            body: {
                error: 'Не удалось собрать правило: ' + session.errors.join('; '),
                errors: session.errors,
                rawRule: session.rule,
            },
        };
    }

    const parsedChatSessionId = chatSessionId ? parseInt(chatSessionId, 10) : null;
    if (parsedChatSessionId && session.snapshotId) {
        await maybeLinkSnapshotToChat({
            chatSessionId: parsedChatSessionId,
            snapshotId: session.snapshotId,
            projectId,
        });
    }
    const finalAssistantMessage =
        toolExchange?.assistantMessage && toolExchange.toolResults?.length
            ? `${toolExchange.assistantMessage}\n\n${session.assistantMessage || ''}`.trim()
            : session.assistantMessage;

    await logChatExchange({
        chatSessionId: parsedChatSessionId,
        projectId,
        snapshotId: session.snapshotId || null,
        userMessage: lastUser?.content || '',
        assistantMessage: finalAssistantMessage,
        toolCalls: toolExchange?.toolResults || null,
    });

    return {
        status: 200,
        body: {
            rule: session.rule,
            ruleSchemaVersion: 2,
            ruleDiff: session.ruleDiff,
            warnings: session.warnings,
            assistantMessage: finalAssistantMessage,
            toolResults: toolExchange?.toolResults || null,
            parsePreview: session.parsePreview,
            snapshotId: session.snapshotId || null,
            compareResult: session.compareResult,
            needsScenarioChoice: session.needsScenarioChoice,
            scenarioId: session.scenarioId,
            candidates: session.candidates,
            treeSample: session.treeSample,
            pendingQuestions: session.pendingQuestions,
            currentQuestion: session.currentQuestion,
            sessionState: session.sessionState,
            preview: excelMeta?.previewText || null,
            layoutAnalysis: session.layoutMeta,
            column_catalog: session.columnCatalog,
            excelMeta: {
                sheetNames: excelMeta.sheetNames,
                sheetName: excelMeta.sheetName,
                suggestedParserType: excelMeta.suggestedParserType,
                suggestedVariant: excelMeta.suggestedVariant,
            },
        },
    };
}

// --- Аудиторы и проекты (области изолированы по slug, auth позже) ---

router.get('/auditors', async (req, res) => {
    try {
        res.json({ ok: true, auditors: await listAuditors(pool) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/martin/bootstrap', async (req, res) => {
    try {
        const user = requireAuthUser(req, res);
        if (!user) return;
        const createChat = req.query.createChat !== '0';
        const session = await bootstrapMartinSession(pool, { userId: user.id, createChat });
        res.json({ ok: true, ...session });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/martin/chats', async (req, res) => {
    try {
        const user = requireAuthUser(req, res);
        if (!user) return;
        const { projectId } = await bootstrapMartinSession(pool, { userId: user.id, createChat: false });
        const title = String(req.body.title || 'Новый чат').trim() || 'Новый чат';
        const chat = await chatSessionStore.createChatSession(projectId, title);
        await pool.query(`UPDATE chat_sessions SET created_by_user_id = $1 WHERE id = $2`, [user.id, chat.id]);
        res.status(201).json({ chat, projectId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/martin/chats', async (req, res) => {
    try {
        const user = requireAuthUser(req, res);
        if (!user) return;
        const session = await bootstrapMartinSession(pool, { userId: user.id, createChat: false });
        const chats = await chatSessionStore.listChatSessions(session.projectId);
        res.json({ chats, projectId: session.projectId });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/martin/chats', async (req, res) => {
    try {
        const user = requireAuthUser(req, res);
        if (!user) return;
        const { projectId } = await bootstrapMartinSession(pool, { userId: user.id, createChat: false });
        await assertProjectAccess(pool, req, projectId);
        await chatSessionStore.deleteAllChatSessions(projectId);
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/projects', async (req, res) => {
    try {
        const user = requireAuthUser(req, res);
        if (!user) return;
        if (user.role === 'boss') {
            const result = await pool.query(
                `SELECT p.*, a.slug AS auditor_slug, a.name AS auditor_name, u.email AS owner_email, u.full_name AS owner_name
                 FROM projects p
                 LEFT JOIN auditors a ON a.id = p.auditor_id
                 LEFT JOIN users u ON u.id = p.owner_user_id
                 ORDER BY p.created_at DESC`
            );
            return res.json(result.rows);
        }
        const result = await pool.query(
            `SELECT p.*, a.slug AS auditor_slug, a.name AS auditor_name
             FROM projects p
             LEFT JOIN auditors a ON a.id = p.auditor_id
             WHERE p.owner_user_id = $1
             ORDER BY p.created_at DESC`,
            [user.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/projects', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Имя проекта обязательно' });
    try {
        const user = requireAuthUser(req, res);
        if (!user) return;
        const auditor = await resolveAuditor(pool, 'martin');
        if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });
        const result = await pool.query(
            `INSERT INTO projects (name, auditor_id, owner_user_id) VALUES ($1, $2, $3) RETURNING *`,
            [name, auditor.id, user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/parsing-rules/examples/list', (req, res) => {
    const dir = path.join(__dirname, 'rules', 'examples');
    try {
        const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
        const examples = files.map((f) => {
            const rule = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            return { file: f, name: rule.meta?.name || f, profile_hint: rule.meta?.profile_hint };
        });
        res.json(examples);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

router.get('/parsing-rules/examples/:file', (req, res) => {
    const file = path.basename(req.params.file);
    const full = path.join(__dirname, 'rules', 'examples', file);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Пример не найден' });
    res.json(JSON.parse(fs.readFileSync(full, 'utf8')));
});

router.get('/parsing-rules/:project_id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM parsing_rules WHERE project_id = $1 ORDER BY created_at DESC',
            [req.params.project_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/parsing-rules', async (req, res) => {
    const {
        project_id,
        source,
        rule_json,
        name,
        parent_id,
        fixture_file_name,
        expected_row_count,
    } = req.body;
    if (!project_id || !rule_json) {
        return res.status(400).json({ error: 'project_id и rule_json обязательны' });
    }

    let ruleObj;
    try {
        ruleObj = typeof rule_json === 'string' ? JSON.parse(rule_json) : rule_json;
    } catch (e) {
        return res.status(400).json({ error: 'rule_json не является корректным JSON' });
    }

    const validated = validateRuleV2(ruleObj);
    if (!validated.ok) {
        return res.status(400).json({ error: validated.errors.join('; ') });
    }

    const layout = validated.rule.layout?.layout_type || '';
    const src =
        String(source || '').toUpperCase() ||
        (layout === 'fixed_columns' ? 'UK' : layout === 'hierarchy_osv' ? 'OSV' : 'OS');
    const ruleName = name || validated.rule.meta?.name || 'Правило';
    const version = parent_id ? 2 : 1;

    try {
        const result = await pool.query(
            `INSERT INTO parsing_rules (
                project_id, source, rule_json, name, version, parent_id,
                fixture_file_name, expected_row_count, rule_schema_version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                project_id,
                src,
                JSON.stringify(validated.rule),
                ruleName,
                version,
                parent_id || null,
                fixture_file_name || null,
                expected_row_count || null,
                2,
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (/column.*does not exist/i.test(err.message)) {
            try {
                const fallback = await pool.query(
            'INSERT INTO parsing_rules (project_id, source, rule_json) VALUES ($1, $2, $3) RETURNING *',
                    [project_id, src, JSON.stringify(validated.rule)]
                );
                return res.status(201).json(fallback.rows[0]);
            } catch (e2) {
                return res.status(500).json({ error: e2.message });
            }
        }
        res.status(500).json({ error: 'Внутренняя ошибка сервера: ' + err.message });
    }
});

router.post('/parsing-rules/:id/clone', async (req, res) => {
    const { project_id, name } = req.body;
    try {
        const orig = await pool.query('SELECT * FROM parsing_rules WHERE id = $1', [req.params.id]);
        if (!orig.rows.length) return res.status(404).json({ error: 'Правило не найдено' });
        const row = orig.rows[0];
        const targetProject = project_id || row.project_id;
        const ruleName = name || `${row.name || 'Правило'} (копия)`;
        const result = await pool.query(
            `INSERT INTO parsing_rules (
                project_id, source, rule_json, name, version, parent_id,
                fixture_file_name, expected_row_count, rule_schema_version
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [
                targetProject,
                row.source,
                row.rule_json,
                ruleName,
                (row.version || 1) + 1,
                row.id,
                row.fixture_file_name,
                row.expected_row_count,
                row.rule_schema_version || 2,
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (/column.*does not exist/i.test(err.message)) {
            return res.status(400).json({ error: 'Запустите npm run migrate для библиотеки правил' });
        }
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/preview', upload.single('file'), fixUploadNamesMiddleware, (req, res) => {
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'Нужен файл Excel' });

    let rule;
    try {
        rule = parseJsonField(req.body.rule, null);
    } catch (e) {
        return res.status(400).json({ error: 'rule: некорректный JSON' });
    }
    if (!rule) return res.status(400).json({ error: 'rule обязателен' });

    try {
        const result = withTempFile(file.buffer, file.originalname, (tmpPath) =>
            runParsePreview(tmpPath, rule, 50)
        );
        if (!result.ok) {
            return res.status(422).json({ error: result.errors.join('; '), errors: result.errors });
        }
        res.json({
            rule: result.rule,
            headers: result.headers,
            rows: result.rows,
            rowCount: result.rowCount,
            warnings: result.warnings || [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/analyze-layout', upload.single('file'), fixUploadNamesMiddleware, (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Нужен файл Excel' });
    try {
        const layout = analyzeLayout(file.buffer, req.body.sheetName);
        res.json(layout);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/sheet-names', upload.single('file'), fixUploadNamesMiddleware, (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Нужен файл Excel' });
    try {
        const { sheetNames, defaultSheet } = listSheetNames(file.buffer);
        res.json({
            sheetNames,
            defaultSheet,
            fileName: file.originalname,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/parse/scenarios', (req, res) => {
    res.json({ scenarios: listScenarios() });
});

router.get('/parser-profiles', (req, res) => {
    res.json({ profiles: listParserProfiles() });
});

router.get('/parser-profiles/:id', (req, res) => {
    const profile = getParserProfile(req.params.id);
    if (!profile) return res.status(404).json({ error: 'Профиль не найден' });
    res.json(profile);
});

router.post('/parser-dispatch', (req, res) => {
    const profileId = String(req.body.profileId || '').trim();
    const out = resolveParserDispatch(profileId);
    if (!out.ok) return res.status(404).json(out);
    res.json(out);
});

router.get('/parse/snapshots/:id', async (req, res) => {
    try {
        const snapshotId = parseInt(req.params.id, 10);
        await assertSnapshotAccess(pool, req, snapshotId);
        const snap = await snapshotStore.getSnapshot(snapshotId);
        if (!snap) return res.status(404).json({ error: 'Снимок не найден' });
        res.json(snap);
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/parse/snapshots/:id/rows', async (req, res) => {
    try {
        const snapshotId = parseInt(req.params.id, 10);
        await assertSnapshotAccess(pool, req, snapshotId);
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '200', 10);
        const data = await snapshotStore.fetchRowsPage(snapshotId, { page, limit });
        if (!data) return res.status(404).json({ error: 'Снимок не найден' });
        res.json(data);
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/parse/snapshots/:id', async (req, res) => {
    try {
        const snapshotId = parseInt(req.params.id, 10);
        await assertSnapshotAccess(pool, req, snapshotId);
        const snap = await snapshotStore.getSnapshot(snapshotId);
        if (!snap) return res.status(404).json({ error: 'Снимок не найден' });
        await snapshotStore.deleteSnapshot(snapshotId);
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/egrul/fetch', async (req, res) => {
    try {
        const message = String(req.body.message || '').trim();
        if (!message) return res.status(400).json({ error: 'Нужен message' });
        if (!isEgrulIntent(message) && !Array.isArray(req.body.inns)) {
            return res.status(400).json({ error: 'Сообщение не похоже на запрос проверки по ЕГРЮЛ' });
        }

        const projectId = parseInt(req.body.projectId || req.body.project_id, 10) || null;
        const sourceSnapshotId =
            parseInt(req.body.sourceSnapshotId || req.body.activeSnapshotId || req.body.snapshotId, 10) ||
            null;
        const chatSessionId = parseInt(req.body.chatSessionId || req.body.chat_session_id, 10) || null;

        const out = await runEgrulCheck(pool, {
            message,
            inns: Array.isArray(req.body.inns) ? req.body.inns : undefined,
            sourceSnapshotId,
            innColumn: req.body.innColumn || req.body.inn_column || null,
            projectId,
        });

        if (!out.ok) {
            return res.status(422).json({ ok: false, error: out.error });
        }

        if (chatSessionId && out.snapshotId) {
            await maybeLinkSnapshotToChat({
                chatSessionId,
                snapshotId: out.snapshotId,
                projectId,
                label: 'ЕГРЮЛ · проверка контрагентов',
            });
        }

        await logChatExchange({
            chatSessionId,
            projectId,
            snapshotId: out.snapshotId,
            userMessage: message,
            assistantMessage: out.assistantMessage,
        });

        res.json(out);
    } catch (err) {
        console.error('[egrul/fetch]', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/snapshots/import-text', upload.single('file'), fixUploadNamesMiddleware, async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: 'Нужен file (.txt)' });

        const routed = await resolveUpload({
            buffer: file.buffer,
            fileName: file.originalname,
        });
        if (!routed.ok) {
            return res.status(422).json({ error: (routed.errors || ['Ошибка маршрутизации']).join('; ') });
        }
        if (routed.route !== 'text' || !routed.textParse?.rows?.length) {
            return res.status(422).json({ error: 'Файл не похож на текстовую выгрузку 1С' });
        }

        const projectId = req.body.project_id || req.body.projectId || null;
        const session = await buildText1cAutostartResponse(file, routed.textParse, routed, { projectId });
        const chatSessionId = req.body.chatSessionId ? parseInt(req.body.chatSessionId, 10) : null;
        if (chatSessionId && session.snapshotId) {
            await maybeLinkSnapshotToChat({
                chatSessionId,
                snapshotId: session.snapshotId,
                projectId,
                label: file.originalname,
            });
        }

        res.json({
            ok: true,
            snapshotId: session.snapshotId,
            parsePreview: session.parsePreview,
            rowCount: session.parsePreview?.rowCount ?? 0,
            assistantMessage: session.assistantMessage,
        });
    } catch (err) {
        console.error('[import-text]', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/snapshots/import-preview', async (req, res) => {
    try {
        const headers = Array.isArray(req.body.headers) ? req.body.headers : [];
        const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
        if (!headers.length) return res.status(400).json({ error: 'headers обязателен' });
        if (!rows.length) return res.status(400).json({ error: 'rows не пустой' });

        const projectId = req.body.projectId ? parseInt(req.body.projectId, 10) : null;
        const chatSessionId = req.body.chatSessionId ? parseInt(req.body.chatSessionId, 10) : null;
        const sourceFileName = String(req.body.sourceFileName || 'preview').trim();
        const sheetName = String(req.body.sheetName || 'лист').trim();
        const scenarioId = req.body.scenarioId || null;

        const snapshotId = await snapshotStore.createSnapshot({
            projectId: Number.isFinite(projectId) ? projectId : null,
            sourceFileName,
            sheetName,
            scenarioId,
            headers,
            status: 'parsing',
        });
        const rowCount = await snapshotStore.importParsedRows(snapshotId, headers, rows);

        if (chatSessionId) {
            await maybeLinkSnapshotToChat({
                chatSessionId,
                snapshotId,
                projectId,
                label: [sourceFileName, sheetName].filter(Boolean).join(' · '),
            });
        }

        const page = await snapshotStore.fetchRowsPage(snapshotId, { page: 1, limit: PREVIEW_ROWS_CLIENT });
        res.json({
            ok: true,
            snapshotId,
            rowCount,
            parsePreview: {
                headers: page?.headers || headers,
                rows: page?.rows || rows.slice(0, PREVIEW_ROWS_CLIENT),
                rowCount,
            },
        });
    } catch (err) {
        console.error('[import-preview]', err.message);
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/snapshots/:id/apply-operation', async (req, res) => {
    const reqStarted = Date.now();
    try {
        const snapshotId = parseInt(req.params.id, 10);
        const message = String(req.body.message || '').trim();
        const options = typeof req.body.options === 'object' && req.body.options ? req.body.options : {};

        console.log(
            `[snapshot-apply] id=${snapshotId} msg=${message.slice(0, 80)}`
        );

        const chatSessionId = req.body.chatSessionId ? parseInt(req.body.chatSessionId, 10) : null;
        const chatHistory = await resolveChatHistory(req.body);

        const result = await applySnapshotOperation(snapshotStore, snapshotId, {
            message,
            options: { ...options, chatHistory },
        });

        if (result.status === 404) {
            return res.status(404).json({ ok: false, error: result.error });
        }
        if (result.status === 409) {
            return res.status(409).json({ ok: false, error: result.error });
        }
        if (!result.ok) {
            return res.status(500).json({ ok: false, error: result.error });
        }

        console.log(
            `[snapshot-apply] done ${Date.now() - reqStarted}ms handled=${result.handled} affected=${result.affectedRows || 0}`
        );

        const snap = await snapshotStore.getSnapshot(snapshotId);

        if (result.newSnapshotId && chatSessionId) {
            const splitLabel =
                result.tableLabel ||
                [snap?.sourceFileName, result.tableLabel].filter(Boolean).join(' · ') ||
                `выборка #${result.newSnapshotId}`;
            await maybeLinkSnapshotToChat({
                chatSessionId,
                snapshotId: result.newSnapshotId,
                label: splitLabel,
                projectId: snap?.projectId,
            });
        }

        if (req.body.logChat && message) {
            await logChatExchange({
                chatSessionId,
                projectId: snap?.projectId,
                snapshotId,
                userMessage: message,
                assistantMessage: result.assistantMessage,
            });
        }

        res.json(result);
    } catch (err) {
        console.error('[snapshot-apply] error', err.message);
        res.status(500).json({ ok: false, handled: false, error: err.message });
    }
});

router.get('/parse/snapshots/:id/operations', async (req, res) => {
    try {
        const snapshotId = parseInt(req.params.id, 10);
        const resOps = await pool.query(
            `SELECT id, message, command_json, rows_affected, created_at
             FROM table_operations WHERE snapshot_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [snapshotId]
        );
        res.json({ operations: resOps.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/projects/:projectId/recipes', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const recipes = await snapshotStore.listRecipes(projectId);
        res.json({ recipes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/projects/:projectId/recipes', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const name = String(req.body.name || '').trim();
        const recipeJson = req.body.recipeJson || req.body.recipe_json;
        if (!name || !recipeJson) {
            return res.status(400).json({ error: 'name и recipeJson обязательны' });
        }
        const id = await snapshotStore.saveRecipe(projectId, name, recipeJson);
        res.json({ ok: true, id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/projects/:projectId/chat-history', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const snapshotId = req.query.snapshotId ? parseInt(req.query.snapshotId, 10) : null;
        let q = `SELECT id, role, content, snapshot_id, chat_session_id, created_at FROM chat_history WHERE project_id = $1`;
        const params = [projectId];
        if (snapshotId) {
            q += ` AND snapshot_id = $2`;
            params.push(snapshotId);
        }
        q += ` ORDER BY created_at ASC LIMIT 200`;
        const rows = await pool.query(q, params);
        res.json({ messages: rows.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/projects/:projectId/chats', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        await assertProjectAccess(pool, req, projectId);
        const chats = await chatSessionStore.listChatSessions(projectId);
        res.json({ chats });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/projects/:projectId/chats', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        await assertProjectAccess(pool, req, projectId);
        const title = String(req.body.title || 'Новый чат').trim() || 'Новый чат';
        const chat = await chatSessionStore.createChatSession(projectId, title);
        if (req.user?.id) {
            await pool.query(`UPDATE chat_sessions SET created_by_user_id = $1 WHERE id = $2`, [
                req.user.id,
                chat.id,
            ]);
        }
        res.status(201).json({ chat });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/projects/:projectId/chats', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        await assertProjectAccess(pool, req, projectId);
        await chatSessionStore.deleteAllChatSessions(projectId);
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.delete('/chats/:chatId', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        await assertChatAccess(pool, req, chatId);
        const chat = await chatSessionStore.getChatSession(chatId);
        if (!chat) return res.status(404).json({ error: 'Чат не найден' });
        await chatSessionStore.deleteChatSession(chatId);
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/chats/:chatId', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        await assertChatAccess(pool, req, chatId);
        const chat = await chatSessionStore.getChatSession(chatId);
        if (!chat) return res.status(404).json({ error: 'Чат не найден' });
        const snapshots = await chatSessionStore.listChatSnapshots(chatId);
        const messages = await chatSessionStore.getChatMessages(chatId);
        res.json({ chat, snapshots, messages });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.get('/chats/:chatId/messages', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        await assertChatAccess(pool, req, chatId);
        const messages = await chatSessionStore.getChatMessages(chatId);
        res.json({ messages });
    } catch (err) {
        if (err instanceof HttpError) return sendAccessError(res, err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/chats/:chatId/snapshots', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        const snapshotId = parseInt(req.body.snapshotId, 10);
        const label = req.body.label ? String(req.body.label) : null;
        if (!Number.isFinite(snapshotId)) {
            return res.status(400).json({ error: 'snapshotId обязателен' });
        }
        const chat = await chatSessionStore.getChatSession(chatId);
        if (!chat) return res.status(404).json({ error: 'Чат не найден' });
        const link = await chatSessionStore.linkSnapshot(chatId, snapshotId, label);
        res.json({ ok: true, link });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/chats/:chatId/snapshots/:snapshotId', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        const snapshotId = parseInt(req.params.snapshotId, 10);
        const hardDelete = req.query.hard === '1' || req.query.hard === 'true';
        const chat = await chatSessionStore.getChatSession(chatId);
        if (!chat) return res.status(404).json({ error: 'Чат не найден' });
        await chatSessionStore.unlinkSnapshot(chatId, snapshotId, { hardDeleteSnapshot: hardDelete });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/plan-preview', express.json(), async (req, res) => {
    try {
        const userMessage = String(req.body.userMessage || '').trim();
        const files = Array.isArray(req.body.files) ? req.body.files : [];
        const probe = req.body.probe || null;
        const parsePlan = await buildParsePlanAsync(userMessage, {
            fileMetas: files,
            probe,
            layoutMeta: req.body.layoutMeta || null,
            orchestratorAnswers: req.body.orchestratorAnswers || {},
            explicitScenarioId: req.body.scenarioId || null,
            explicitFilePrefix: req.body.filePrefix || null,
            explicitSheetName: req.body.sheetName || null,
            parseAllSheets: req.body.parseAllSheets,
        });
        const reasoningTrace = buildReasoningTrace({
            parsePlan,
            outcome: 'plan',
            fileName: files[0]?.name || files[0]?.relativePath || null,
        });
        res.json({ ok: true, parsePlan, reasoningTrace });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/probe-meta', express.json(), (req, res) => {
    try {
        const files = Array.isArray(req.body.files) ? req.body.files : [];
        const userMessage = String(req.body.userMessage || '').trim();
        const probe = probeFileList(files, userMessage);
        res.json({ ok: true, probe });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/parse/probe', upload.single('file'), fixUploadNamesMiddleware, async (req, res) => {
    try {
        const file = req.file;
        const userMessage = String(req.body.userMessage || '').trim();
        if (!file) {
            const files = [];
            try {
                const parsed = JSON.parse(req.body.filesMeta || '[]');
                if (Array.isArray(parsed)) files.push(...parsed);
            } catch {
                /* ignore */
            }
            if (!files.length) return res.status(400).json({ error: 'Нужен file или filesMeta' });
            const probe = probeFileList(files, userMessage);
            return res.json({ ok: true, probe });
        }
        const probe = await probeUploadedFile(file, userMessage);
        res.json({ ok: true, probe });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

async function runBatchStartFromUploads({ files, targetFile, body, res }) {
    let orchestratorAnswers = {};
    try {
        orchestratorAnswers = parseJsonField(body.orchestratorAnswers, {}) || {};
    } catch {
        orchestratorAnswers = {};
    }

    const userMessage = String(body.userMessage || '').trim();
    const projectId = body.project_id || body.projectId || null;
    const chatSessionId = body.chatSessionId ? parseInt(body.chatSessionId, 10) : null;

    if (body.fromInbox && !userMessage) {
        return res.status(422).json({
            error: 'Напиши задачу в чате перед парсом — там могут быть правила и сценарий.',
        });
    }

    const parsePlan = await buildParsePlanAsync(userMessage, {
        files,
        orchestratorAnswers,
        explicitScenarioId: body.scenarioId || null,
        explicitFilePrefix: body.filePrefix || orchestratorAnswers.filePrefix || null,
        explicitSheetName: body.sheetName || orchestratorAnswers.sheetName || null,
        parseAllSheets: body.parseAllSheets,
    });
    orchestratorAnswers = applyParsePlanToOrchestratorAnswers(parsePlan, orchestratorAnswers);

    const scenarioId =
        parsePlan.scenarioId ||
        body.scenarioId ||
        orchestratorAnswers.scenarioId ||
        detectBatchScenario(files, userMessage, null);

    const appendSnapshotId = body.appendSnapshotId
        ? parseInt(body.appendSnapshotId, 10)
        : null;

    if (appendSnapshotId && files.length >= 1 && !isOpifScenario(scenarioId)) {
        let savedRulesAppend = [];
        if (projectId) savedRulesAppend = await fetchSavedRulesByProject(projectId);
        const appendResult = await handleUniversalAppend({
            pool,
            snapshotStore,
            files,
            appendSnapshotId,
            projectId,
            userMessage,
            chatSessionId,
            targetFile,
            savedRules: savedRulesAppend,
            maybeLinkSnapshotToChat,
            logChatExchange,
        });
        if (!appendResult.ok) {
            return res.status(appendResult.status || 422).json({
                error: appendResult.error,
                headerMismatch: appendResult.headerMismatch || false,
            });
        }
        return safeResJson(res, {
            ...appendResult,
            parsePlan,
            staged: false,
            fromInbox: Boolean(body.fromInbox),
        });
    }

    let structureGroups = null;
    let structureRawGroups = null;
    let mergeStrategy =
        orchestratorAnswers.mergeStrategy ||
        orchestratorAnswers.pick_merge_strategy ||
        parsePlan.mergeStrategy ||
        null;

    if (files.length > 1 && !isOpifScenario(scenarioId)) {
        const mergeCtx = await resolveBatchMergeContext({
            files,
            orchestratorAnswers,
            userMessage,
            scenarioId,
            appendSnapshotId,
            isOpif: isOpifScenario(scenarioId),
        });
        structureGroups = mergeCtx.groups;
        structureRawGroups = mergeCtx.rawGroups || null;
        parsePlan.groups = structureGroups;

        if (!mergeCtx.proceed) {
            const question = mergeCtx.question;
            return res.json({
                ok: true,
                needsUserInput: true,
                needsConfirm: true,
                pendingQuestions: [question],
                currentQuestion: question,
                groups: structureGroups,
                parsePlan,
                assistantMessage: question.promptTemplate,
                staged: true,
                fromInbox: Boolean(body.fromInbox),
            });
        }
        mergeStrategy = mergeCtx.mergeStrategy;
        parsePlan.mergeStrategy = mergeStrategy;
        orchestratorAnswers = {
            ...orchestratorAnswers,
            mergeStrategy,
            pick_merge_strategy: mergeStrategy,
        };
    }

    const filePrefixForBatch =
        parsePlan.filePrefix || body.filePrefix || orchestratorAnswers.filePrefix;

    if (isOpifScenario(scenarioId)) {
                const appendSnapshotId = body.appendSnapshotId
                    ? parseInt(body.appendSnapshotId, 10)
                    : null;
                const brokerChunkIndex = Math.max(1, parseInt(body.brokerChunkIndex || '1', 10));
                const brokerChunkTotal = Math.max(1, parseInt(body.brokerChunkTotal || '1', 10));
                const brokerFilesTotal = parseInt(body.brokerFilesTotal || '0', 10) || null;
                const isLastChunk = brokerChunkIndex >= brokerChunkTotal;

                const parsed = await parseOpifBatch(
                    files,
                    scenarioId,
                    userMessage,
                    filePrefixForBatch,
                    parsePlan.brokerSection || orchestratorAnswers.brokerSection
                );
                if (!parsed.rows.length && !appendSnapshotId) {
                    return res.status(422).json({
                        error: (parsed.errors || ['Нет строк после парса']).join('; '),
                        warnings: parsed.warnings,
                    });
                }

                const labelName =
                    brokerFilesTotal && brokerFilesTotal > 1
                        ? `${scenarioId}_${brokerFilesTotal}files`
                        : files.length === 1
                          ? fileNameOf(files[0])
                          : `${scenarioId}_${files.length}files`;

                let snapshotId = appendSnapshotId;
                let rowCount = 0;

                if (appendSnapshotId) {
                    if (parsed.rows.length) {
                        const appended = await snapshotStore.appendParsedRows(
                            appendSnapshotId,
                            parsed.rows
                        );
                        rowCount = appended.rowCount;
                    } else {
                        const snap = await snapshotStore.getSnapshot(appendSnapshotId);
                        rowCount = snap?.rowCount ?? 0;
                    }
                } else {
                    snapshotId = await snapshotStore.createSnapshot({
                        projectId: projectId ? parseInt(projectId, 10) : null,
                        sourceFileName: labelName,
                        sheetName: null,
                        scenarioId,
                        headers: parsed.headers,
                        status: 'parsing',
                    });
                    rowCount = await snapshotStore.importParsedRows(
                        snapshotId,
                        parsed.headers,
                        parsed.rows
                    );
                }

                const previewRows = parsed.rows.length
                    ? parsed.rows.slice(0, PREVIEW_ROWS_CLIENT)
                    : [];
                const snapForPreview =
                    previewRows.length < 1 && snapshotId
                        ? await snapshotStore.fetchRowsPage(snapshotId, { page: 1, limit: PREVIEW_ROWS_CLIENT })
                        : null;
                const previewHeaders = parsed.headers?.length
                    ? parsed.headers
                    : snapForPreview?.headers || OPIF_SNAPSHOT_HEADERS;

                const chunkBody = {
                    ok: true,
                    scenarioId,
                    scenarioName: scenarioDisplayName(scenarioId),
                    sourceKind: scenarioId === 'opif_depo' ? 'pdf' : 'excel',
                    snapshotId,
                    parsePreview: {
                        headers: previewHeaders,
                        rows: previewRows.length ? previewRows : snapForPreview?.rows || [],
                        rowCount,
                    },
                    warnings: parsed.warnings,
                    parsePlan,
                    staged: false,
                    needsUserInput: false,
                    brokerChunk: {
                        index: brokerChunkIndex,
                        total: brokerChunkTotal,
                        filesInChunk: parsed.filesProcessed,
                    },
                };

                if (!isLastChunk) {
                    chunkBody.chunkInProgress = true;
                    return res.json(chunkBody);
                }

                const assistantMessage = [
                    buildOpifAssistantMessage(scenarioId, {
                        filesProcessed: brokerFilesTotal || parsed.filesProcessed,
                        filesMatched: brokerFilesTotal || parsed.filesMatched,
                        rowCount,
                        prefix: filePrefixForBatch,
                        brokerSection: parsed.brokerSection,
                        warnings: parsed.warnings,
                    }),
                    body.fromInbox
                        ? `Источник: **хранилище** на сервере (inbox).`
                        : '',
                    brokerChunkTotal > 1 ? `Пачек по ${MAX_BATCH_FILES} файлов: **${brokerChunkTotal}**.` : '',
                    parsePlan.summary ? `\n📋 План: ${parsePlan.summary}` : '',
                ]
                    .filter(Boolean)
                    .join('\n');

                if (chatSessionId && !appendSnapshotId) {
                    await maybeLinkSnapshotToChat({
                        chatSessionId,
                        snapshotId,
                        projectId,
                        label: labelName,
                    });
                }
                await logChatExchange({
                    chatSessionId,
                    projectId,
                    snapshotId,
                    userMessage: userMessage || '(старт парса)',
                    assistantMessage,
                });

                return res.json({
                    ...chunkBody,
                    assistantMessage,
                    chunkInProgress: false,
                });
            }

            if (files.length > 1 && userMessage && !isOpifScenario(scenarioId)) {
                const excelOnly = files.filter((f) => detectSourceKind(fileNameOf(f)) === 'excel');
                const pdfOnly = files.filter((f) => isPdfLikeFile(f));
                const homogenousExcel = excelOnly.length === files.length;
                const homogenousPdf = pdfOnly.length === files.length;

                if (homogenousPdf && mergeStrategy === 'one_table' && scenarioId !== 'broker_pdf') {
                    return parseMultiplePdfDocumentsFromBatch({
                        pool,
                        files: pdfOnly,
                        projectId,
                        userMessage,
                        chatSessionId,
                        parsePlan,
                        res,
                        orchestratorAnswers,
                    });
                }

                if (
                    (homogenousExcel || homogenousPdf) &&
                    mergeStrategy &&
                    !(homogenousPdf && scenarioId === 'broker_pdf' && mergeStrategy === 'per_file')
                ) {
                    let savedRulesMulti = [];
                    if (projectId) savedRulesMulti = await fetchSavedRulesByProject(projectId);
                    const batchResult = await runBatchWithMergeStrategy({
                        pool,
                        snapshotStore,
                        files: homogenousExcel ? excelOnly : pdfOnly,
                        rawGroups: structureRawGroups,
                        mergeStrategy,
                        targetFile,
                        projectId,
                        savedRules: savedRulesMulti,
                        userMessage,
                        chatSessionId,
                        parsePlan,
                        maybeLinkSnapshotToChat,
                        logChatExchange,
                    });
                    if (!batchResult.ok) {
                        return res.status(422).json({
                            error: batchResult.error,
                            skipped: batchResult.skipped,
                            parsePlan,
                        });
                    }
                    return safeResJson(res, {
                        ...batchResult,
                        parsePlan,
                        staged: false,
                        fromInbox: Boolean(body.fromInbox),
                        needsUserInput: false,
                    });
                }

                if (body.pathScope?.path && pdfOnly.length >= 1) {
                    return parseMultiplePdfDocumentsFromBatch({
                        pool,
                        files: pdfOnly,
                        projectId,
                        userMessage,
                        chatSessionId,
                        parsePlan,
                        res,
                        orchestratorAnswers,
                    });
                }
                if (body.pathScope?.path && excelOnly.length >= 1) {
                    if (excelOnly.length === 1) {
                        files = excelOnly;
                    } else {
                        let savedRulesMulti = [];
                        if (projectId) savedRulesMulti = await fetchSavedRulesByProject(projectId);
                        return parseMultipleExcelWorkbooksFromBatch({
                            pool,
                            files: excelOnly,
                            targetFile,
                            projectId,
                            savedRules: savedRulesMulti,
                            userMessage,
                            chatSessionId,
                            parsePlan,
                            res,
                        });
                    }
                }
            }

            if (files.length > 1) {
                return res.status(422).json({
                    error:
                        'Несколько файлов без явного сценария. Выбери **один файл/папку** через 📎 или напиши задачу: «депо», «брокер 1F018», «разбери ОС» и т.п.',
                });
            }

            const sourceFile = files[0];
            let sheetName = parsePlan.sheetName || body.sheetName;

            let savedRules = [];
            if (projectId) savedRules = await fetchSavedRulesByProject(projectId);

            const { sheetNames: workbookSheets, defaultSheet } = listSheetNames(sourceFile.buffer);
            const rawOrchestratorAnswers = { ...orchestratorAnswers };
            const explicitScenarioForStructure = parsePlan.scenarioId || body.scenarioId || null;

            const useAllSheetsEarly = wantsMultiSheetExcelParse({
                files,
                sheetNames: workbookSheets,
                scenarioId: explicitScenarioForStructure,
                parseAllSheets: body.parseAllSheets,
                orchestratorAnswers: rawOrchestratorAnswers,
                sheetName,
                parsePlan,
            });

            if (useAllSheetsEarly) {
                const multiStarted = Date.now();
                console.log('[batch-start] multi-sheet parse', fileNameOf(sourceFile));
                const multi = await parseAllExcelSheets({
                    pool,
                    file: sourceFile,
                    targetFile,
                    projectId,
                    savedRules,
                    userMessage: userMessage || '',
                });

                if (!multi.ok) {
                    return res.status(422).json({
                        error:
                            multi.skipped?.map((s) => `${s.sheetName}: ${s.reason}`).join('; ') ||
                            'Не удалось разобрать ни один лист Excel',
                        skipped: multi.skipped,
                    });
                }

                const snapshots = multi.parsed.map((p) => ({
                    snapshotId: p.snapshotId,
                    sheetName: p.sheetName,
                    label: `${p.sheetName} · ${p.rowCount}`,
                    rowCount: p.rowCount,
                    scenarioId: p.scenarioId,
                    scenarioName: p.scenarioName,
                    validationReport: p.validationReport || null,
                }));

                if (chatSessionId) {
                    for (const p of multi.parsed) {
                        await maybeLinkSnapshotToChat({
                            chatSessionId,
                            snapshotId: p.snapshotId,
                            projectId,
                            label: `${p.sheetName} · ${p.rowCount}`,
                        });
                    }
                }
                if (chatSessionId && multi.assistantMessage) {
                    const chatLogFn = () =>
                        logChatExchange({
                            chatSessionId,
                            projectId,
                            snapshotId: multi.primary?.snapshotId,
                            userMessage: userMessage || '(старт парса)',
                            assistantMessage: multi.assistantMessage,
                        });
                    console.log(
                        '[batch-start] multi-sheet done',
                        `${multi.parsed.length} sheets in ${Date.now() - multiStarted}ms`
                    );
                    const primary = multi.primary;
                    return safeResJsonAndLogChat(
                        res,
                        {
                            ok: true,
                            multiSheet: true,
                            snapshots,
                            sheetNames: multi.sheetNames,
                            snapshotId: primary?.snapshotId,
                            parsePreview: primary?.parsePreview,
                            scenarioId: primary?.scenarioId,
                            scenarioName: primary?.scenarioName,
                            rule: primary?.rule,
                            layoutAnalysis: primary?.layoutMeta,
                            structureId: primary?.structureId,
                            structure: primary?.structure,
                            validationReport: primary?.validationReport || null,
                            warnings: multi.warnings,
                            assistantMessage: multi.assistantMessage,
                            skippedSheets: multi.skipped,
                            needsUserInput: false,
                            needsScenarioChoice: false,
                            previewIsTentative: false,
                            userMessage,
                            parsePlan,
                            staged: false,
                        },
                        chatLogFn
                    );
                }

                console.log(
                    '[batch-start] multi-sheet done',
                    `${multi.parsed.length} sheets in ${Date.now() - multiStarted}ms`
                );
                const primary = multi.primary;
                return safeResJson(res, {
                    ok: true,
                    multiSheet: true,
                    snapshots,
                    sheetNames: multi.sheetNames,
                    snapshotId: primary?.snapshotId,
                    parsePreview: primary?.parsePreview,
                    scenarioId: primary?.scenarioId,
                    scenarioName: primary?.scenarioName,
                    rule: primary?.rule,
                    layoutAnalysis: primary?.layoutMeta,
                    structureId: primary?.structureId,
                    structure: primary?.structure,
                    validationReport: primary?.validationReport || null,
                    warnings: multi.warnings,
                    assistantMessage: multi.assistantMessage,
                    skippedSheets: multi.skipped,
                    needsUserInput: false,
                    needsScenarioChoice: false,
                    previewIsTentative: false,
                    userMessage,
                    parsePlan,
                    staged: false,
                });
            }

            const sheetForStructureEarly =
                sheetName || rawOrchestratorAnswers?.sheetName || defaultSheet;

            const structureHandledEarly = await applyStructureAutostartToBatch({
                pool,
                sourceFile,
                targetFile,
                sheetName: sheetForStructureEarly,
                projectId,
                savedRules,
                scenarioId: explicitScenarioForStructure,
                orchestratorAnswers: rawOrchestratorAnswers,
                userMessage,
                chatSessionId,
                parsePlan,
                res,
            });
            if (structureHandledEarly) return;

            orchestratorAnswers = applyAutostartDefaults(
                analyzeLayout(sourceFile.buffer, sheetName || defaultSheet, {
                    fileName: sourceFile.originalname,
                }),
                orchestratorAnswers
            );

            const routed = await resolveUpload({
                buffer: sourceFile.buffer,
                fileName: sourceFile.originalname,
                sheetName,
                targetBuffer: targetFile?.buffer,
                orchestratorAnswers,
            });

            if (!routed.ok) {
                return res.status(422).json({
                    error: (routed.errors || ['Ошибка маршрутизации']).join('; '),
                    errors: routed.errors,
                });
            }

            if (
                routed.route === 'universal_pdf' ||
                (routed.sourceKind === 'pdf' && !isOpifScenario(scenarioId))
            ) {
                return respondUniversalPdfAutostart(res, {
                    sourceFile,
                    routed,
                    projectId,
                    userMessage,
                    chatSessionId,
                    orchestratorAnswers: rawOrchestratorAnswers,
                });
            }

            if (routed.route === 'text') {
                const session = await buildText1cAutostartResponse(sourceFile, routed.textParse, routed, {
                    projectId,
                });
                if (chatSessionId && session.snapshotId) {
                    await maybeLinkSnapshotToChat({
                        chatSessionId,
                        snapshotId: session.snapshotId,
                        projectId,
                        label: sourceFile.originalname,
                    });
                }
                if (chatSessionId && session.assistantMessage) {
                    await logChatExchange({
                        chatSessionId,
                        projectId,
                        snapshotId: session.snapshotId,
                        userMessage: userMessage || '(старт парса)',
                        assistantMessage: session.assistantMessage,
                    });
                }
                return res.json({ ...session, userMessage });
            }

            let savedRulesSingle = savedRules;
            if (!savedRulesSingle.length && projectId) {
                savedRulesSingle = await fetchSavedRulesByProject(projectId);
            }

            const session = await runMartinSession({
                file: sourceFile,
                targetFile,
                layoutMeta: routed.layoutMeta,
                currentRule: null,
                userMessage,
                messages: userMessage ? [{ role: 'user', content: userMessage }] : [],
                isFirstPass: true,
                scenarioId: scenarioId || routed.scenarioId || null,
                orchestratorAnswers,
                savedRules: savedRulesSingle,
                projectId,
                routerResult: routed,
            });

            if (!session.ok) {
                return res.status(422).json({ error: session.errors.join('; '), errors: session.errors });
            }

            if (chatSessionId && session.snapshotId) {
                await maybeLinkSnapshotToChat({
                    chatSessionId,
                    snapshotId: session.snapshotId,
                    projectId,
                    label: sourceFile.originalname,
                });
            }
            if (chatSessionId && session.assistantMessage) {
                const chatLogFn = () =>
                    logChatExchange({
                        chatSessionId,
                        projectId,
                        snapshotId: session.snapshotId,
                        userMessage: userMessage || '(старт парса)',
                        assistantMessage: session.assistantMessage,
                    });
                return safeResJsonAndLogChat(
                    res,
                    { ...session, userMessage, staged: false, fromInbox: Boolean(body.fromInbox) },
                    chatLogFn
                );
            }

            return safeResJson(res, { ...session, userMessage, staged: false, fromInbox: Boolean(body.fromInbox) });
}

router.post(
    '/parse/batch-start',
    upload.fields([
        { name: 'files', maxCount: MAX_BATCH_FILES },
        { name: 'file', maxCount: 1 },
        { name: 'target', maxCount: 1 },
    ]),
    fixUploadNamesMiddleware,
    async (req, res) => {
        try {
            const uploaded = req.files?.files?.length
                ? req.files.files
                : req.files?.file || [];
            if (!uploaded.length) {
                return res.status(400).json({ error: 'Нужен хотя бы один файл' });
            }
            await runBatchStartFromUploads({
                files: uploaded,
                targetFile: req.files?.target?.[0] || null,
                body: req.body,
                res,
            });
        } catch (err) {
            console.error('[batch-start] error', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    }
);

router.post('/parse/universal', upload.single('file'), fixUploadNamesMiddleware, async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Нужен file' });

    try {
        const routed = await resolveUpload({
            buffer: file.buffer,
            fileName: file.originalname,
            sheetName: req.body.sheetName,
        });
        if (!routed.ok) {
            return res.status(422).json({ error: (routed.errors || ['Ошибка маршрутизации']).join('; ') });
        }
        const projectId = req.body.project_id || req.body.projectId || null;
        const session = await buildUniversalAutostartResponse(file, routed, {
            projectId,
            userMessage: req.body.userMessage || req.body.prompt || '',
        });
        if (!session.ok) {
            if (session.delegateDepo) {
                return res.status(422).json({ error: 'PDF ДЕПО — используйте раздел ОПИФ.' });
            }
            return res.status(422).json({ error: (session.errors || ['Ошибка парсинга']).join('; ') });
        }
        res.json(session);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/auto-start', upload.fields([{ name: 'file' }, { name: 'target' }]), fixUploadNamesMiddleware, async (req, res) => {
    const sourceFile = req.files?.file?.[0];
    const targetFile = req.files?.target?.[0];
    if (!sourceFile) return res.status(400).json({ error: 'Нужен file (исходник 1С)' });

    try {
        let orchestratorAnswers = {};
        try {
            orchestratorAnswers = parseJsonField(req.body.orchestratorAnswers, {}) || {};
        } catch {
            orchestratorAnswers = {};
        }

        let sheetName = req.body.sheetName;
        const { defaultSheet: autoSheet } = listSheetNames(sourceFile.buffer);
        const rawOrchestratorAnswers = { ...orchestratorAnswers };
        const explicitScenarioForStructure = req.body.scenarioId || null;
        const projectIdEarly = req.body.project_id || req.body.projectId || null;
        let savedRulesEarly = [];
        if (projectIdEarly) savedRulesEarly = await fetchSavedRulesByProject(projectIdEarly);
        const chatSessionIdEarly = req.body.chatSessionId || req.body.chat_session_id;
        const parsedChatSessionIdEarly = chatSessionIdEarly ? parseInt(chatSessionIdEarly, 10) : null;

        const structureHandledEarly = await applyStructureAutostartToBatch({
            pool,
            sourceFile,
            targetFile,
            sheetName: sheetName || rawOrchestratorAnswers?.sheetName || autoSheet,
            projectId: projectIdEarly,
            savedRules: savedRulesEarly,
            scenarioId: explicitScenarioForStructure,
            orchestratorAnswers: rawOrchestratorAnswers,
            userMessage: req.body.userMessage || '',
            chatSessionId: parsedChatSessionIdEarly,
            res,
        });
        if (structureHandledEarly) return;

        orchestratorAnswers = applyAutostartDefaults(
            analyzeLayout(sourceFile.buffer, sheetName || autoSheet, {
                fileName: sourceFile.originalname,
            }),
            orchestratorAnswers
        );
        if (orchestratorAnswers?.pick_tree_flatten === 'confirm' && sheetName && /кс/i.test(sheetName)) {
            const { sheetNames: namesForPick } = listSheetNames(sourceFile.buffer);
            const osvSheet = pickPreferredSheet(namesForPick);
            if (osvSheet && /осв/i.test(osvSheet)) sheetName = osvSheet;
        }

        const routed = await resolveUpload({
            buffer: sourceFile.buffer,
            fileName: sourceFile.originalname,
            sheetName,
            targetBuffer: targetFile?.buffer,
            orchestratorAnswers,
        });

        if (!routed.ok) {
            return res.status(422).json({
                error: (routed.errors || ['Ошибка маршрутизации']).join('; '),
                errors: routed.errors,
            });
        }

        if (routed.route === 'universal_pdf' || (routed.sourceKind === 'pdf' && routed.scenarioId === 'upd_ediweb')) {
            const projectId = req.body.project_id || req.body.projectId || null;
            const chatSessionId = req.body.chatSessionId || req.body.chat_session_id;
            const parsedChatSessionId = chatSessionId ? parseInt(chatSessionId, 10) : null;
            return respondUniversalPdfAutostart(res, {
                sourceFile,
                routed,
                projectId,
                userMessage: req.body.userMessage || '',
                chatSessionId: parsedChatSessionId,
                orchestratorAnswers,
            });
        }

        if (routed.route === 'text') {
            const projectId = req.body.project_id || req.body.projectId || null;
            const session = await buildText1cAutostartResponse(sourceFile, routed.textParse, routed, {
                projectId,
            });
            const chatSessionId = req.body.chatSessionId || req.body.chat_session_id;
            const parsedChatSessionId = chatSessionId ? parseInt(chatSessionId, 10) : null;
            if (parsedChatSessionId && session.snapshotId) {
                await maybeLinkSnapshotToChat({
                    chatSessionId: parsedChatSessionId,
                    snapshotId: session.snapshotId,
                    projectId,
                    label: sourceFile.originalname,
                });
            }
            if (parsedChatSessionId && session.assistantMessage) {
                await chatSessionStore.appendChatMessage({
                    chatSessionId: parsedChatSessionId,
                    projectId,
                    snapshotId: session.snapshotId,
                    role: 'assistant',
                    content: session.assistantMessage,
                });
            }
            return res.json(session);
        }

        let savedRules = [];
        const projectId = req.body.project_id || req.body.projectId;
        if (projectId) savedRules = await fetchSavedRulesByProject(projectId);

        const chatSessionIdAuto = req.body.chatSessionId || req.body.chat_session_id;
        const parsedChatSessionIdAuto = chatSessionIdAuto ? parseInt(chatSessionIdAuto, 10) : null;
        const scenarioIdAuto = req.body.scenarioId || routed.scenarioId || null;

        const session = await runMartinSession({
            file: sourceFile,
            targetFile,
            layoutMeta: routed.layoutMeta,
            currentRule: null,
            userMessage: '',
            messages: [],
            isFirstPass: true,
            scenarioId: scenarioIdAuto,
            orchestratorAnswers,
            savedRules,
            projectId: projectId || null,
            routerResult: routed,
        });
        if (!session.ok) {
            return res.status(422).json({ error: session.errors.join('; '), errors: session.errors });
        }

        const chatSessionId = req.body.chatSessionId || req.body.chat_session_id;
        const parsedChatSessionId = chatSessionId ? parseInt(chatSessionId, 10) : null;
        if (parsedChatSessionId && session.snapshotId) {
            await maybeLinkSnapshotToChat({
                chatSessionId: parsedChatSessionId,
                snapshotId: session.snapshotId,
                projectId: projectId || null,
                label: sourceFile.originalname,
            });
        }
        if (parsedChatSessionId && session.assistantMessage) {
            await chatSessionStore.appendChatMessage({
                chatSessionId: parsedChatSessionId,
                projectId: projectId || null,
                snapshotId: session.snapshotId || null,
                role: 'assistant',
                content: session.assistantMessage,
            });
        }

        res.json({
            rule: session.rule,
            snapshotId: session.snapshotId || null,
            parsePreview: session.parsePreview,
            compareResult: session.compareResult,
            assistantMessage: session.assistantMessage,
            warnings: session.warnings,
            layoutAnalysis: session.layoutMeta,
            sheetNames: session.layoutMeta?.sheetNames || routed.sheetNames || [],
            sheetName: session.layoutMeta?.sheetName || routed.sheetName || null,
            needsScenarioChoice: session.needsScenarioChoice,
            scenarioId: session.scenarioId,
            scenarioName: scenarioDisplayName(session.scenarioId),
            confidence: routed.confidence,
            sourceKind: routed.sourceKind,
            candidates: session.candidates,
            treeSample: session.treeSample,
            pendingQuestions: session.pendingQuestions,
            currentQuestion: session.currentQuestion,
            sessionState: session.sessionState,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/infer-from-target', upload.fields([{ name: 'file' }, { name: 'target' }]), fixUploadNamesMiddleware, async (req, res) => {
    const sourceFile = req.files?.file?.[0];
    const targetFile = req.files?.target?.[0];
    if (!sourceFile) return res.status(400).json({ error: 'Нужен file (исходник 1С)' });
    if (!targetFile) return res.status(400).json({ error: 'Нужен target (эталон 5–20 строк)' });

    try {
        const layout = analyzeLayout(sourceFile.buffer, req.body.sheetName);
        const target = loadTargetRows(targetFile.buffer, { sheetName: req.body.targetSheetName });
        let rule = applyTargetToRule(loadExample('os_hierarchy_01.json'), target, layout.column_catalog);
        const validated = validateRuleV2(rule);
        if (!validated.ok) {
            return res.status(422).json({ error: validated.errors.join('; '), errors: validated.errors });
        }
        rule = validated.rule;

        const previewResult = withTempFile(sourceFile.buffer, sourceFile.originalname, (tmpPath) =>
            runParsePreview(tmpPath, rule, 5000)
        );

        res.json({
            rule,
            target: { headers: target.headers, rowCount: target.rows.length },
            parsePreview: previewResult.ok
                ? { headers: previewResult.headers, rows: previewResult.rows, rowCount: previewResult.rowCount }
                : null,
            warnings: previewResult.warnings || [],
            errors: previewResult.ok ? [] : previewResult.errors,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/parse/compare-target', upload.fields([{ name: 'file' }, { name: 'target' }]), fixUploadNamesMiddleware, (req, res) => {
    const sourceFile = req.files?.file?.[0];
    const targetFile = req.files?.target?.[0];
    if (!sourceFile) return res.status(400).json({ error: 'Нужен file (исходник для парсинга)' });

    let rule;
    try {
        rule = parseJsonField(req.body.rule, null);
    } catch (e) {
        return res.status(400).json({ error: 'rule: некорректный JSON' });
    }
    if (!rule) return res.status(400).json({ error: 'rule обязателен' });

    try {
        const previewResult = withTempFile(sourceFile.buffer, sourceFile.originalname, (tmpPath) =>
            runParsePreview(tmpPath, rule, 5000)
        );
        if (!previewResult.ok) {
            return res.status(422).json({ error: previewResult.errors.join('; ') });
        }

        let target;
        if (targetFile) {
            target = loadTargetRows(targetFile.buffer, { sheetName: req.body.targetSheetName });
        } else if (req.body.targetRows) {
            const parsed = parseJsonField(req.body.targetRows, null);
            target = { headers: parsed.headers || [], rows: parsed.rows || [] };
        } else {
            return res.status(400).json({ error: 'Нужен target (файл эталона) или targetRows JSON' });
        }

        const comparison = comparePreviewToTarget(
            { headers: previewResult.headers, rows: previewResult.rows },
            target,
            { keyColumns: parseJsonField(req.body.keyColumns, undefined) }
        );

        res.json({
            preview: {
                rowCount: previewResult.rowCount,
                headers: previewResult.headers,
            },
            target: { rowCount: target.rows.length, sheetName: target.sheetName },
            comparison,
            warnings: previewResult.warnings || [],
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/ai/result-table-action', async (req, res) => {
    const reqStarted = Date.now();
    try {
        const message = String(req.body.message || '').trim();
        const headers = Array.isArray(req.body.headers) ? req.body.headers : [];
        const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
        const options = typeof req.body.options === 'object' && req.body.options ? req.body.options : {};
        const chatHistory = await resolveChatHistory(req.body);

        const { command, planner, needsSnapshot } = await resolveTableCommand({
            message,
            headers,
            rows,
            options: { ...options, chatHistory },
        });

        console.log(
            `[result-table-action] planner=${planner} action=${command.action} column=${command.sourceColumn || '-'} rows=${rows.length} msg=${message.slice(0, 80)}`
        );

        if (!command.action) {
            console.log(`[result-table-action] unhandled ${Date.now() - reqStarted}ms`);
            return res.json({ ok: true, handled: false, command });
        }

        if (needsSnapshot) {
            return res.json({
                ok: true,
                handled: false,
                needsSnapshot: true,
                command,
                assistantMessage:
                    'Эта команда работает только когда таблица сохранена в БД (snapshot). Перезагрузи файл или дождись полного парса — тогда фильтры и мутации пойдут по всем строкам.',
            });
        }

        if (command.action === 'filter_rows') {
            const { applyFilterToRows, buildFilterAssistantMessage } = require('./table_row_filter');
            if (!command.filters?.length) {
                return res.json({
                    ok: true,
                    handled: true,
                    command,
                    assistantMessage:
                        (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                        'Не смогла разобрать условия фильтра. Пример: «оставь только debit_account=58.01.4 и credit_account=76.07.2».',
                });
            }
            const filtered = applyFilterToRows(rows, command);
            console.log(
                `[result-table-action] filter_rows done ${Date.now() - reqStarted}ms kept=${filtered.kept} removed=${filtered.removed}`
            );
            return res.json({
                ok: true,
                handled: true,
                command: { ...command, ...filtered.plan },
                filteredRows: filtered.rows,
                rowCount: filtered.kept,
                filterStats: {
                    before: rows.length,
                    after: filtered.kept,
                    removed: filtered.removed,
                    plan: filtered.plan,
                },
                assistantMessage:
                    (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                    buildFilterAssistantMessage(filtered.plan, {
                        before: rows.length,
                        after: filtered.kept,
                        removed: filtered.removed,
                    }),
            });
        }

        if (command.action === 'delete_column') {
            const col = command.deleteColumn || command.sourceColumn;
            return res.json({
                ok: true,
                handled: true,
                command,
                deleteColumn: col,
                assistantMessage: col
                    ? `${command.explanation ? command.explanation + '\n\n' : ''}Убираю колонку «${col}».`
                    : `Не нашла колонку «${command.rawColumnHint || '...'}». Доступные: ${headers.slice(0, 8).join(', ')}`,
            });
        }

        if (command.action === 'split_to_table') {
            const { applyFilterToRows, buildSplitAssistantMessage } = require('./table_row_filter');
            if (!command.filters?.length) {
                return res.json({
                    ok: true,
                    handled: true,
                    command,
                    assistantMessage:
                        (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                        'Не смогла разобрать, какие строки переносить. Например: «создай вкладку Lukoil — где Инструмент содержит Lukoil Capital».',
                });
            }
            const filtered = applyFilterToRows(rows, command);
            console.log(
                `[result-table-action] split_to_table done ${Date.now() - reqStarted}ms kept=${filtered.kept} removed=${filtered.removed}`
            );
            return res.json({
                ok: true,
                handled: true,
                command: { ...command, ...filtered.plan },
                filteredRows: filtered.rows,
                rowCount: filtered.kept,
                tableLabel: command.tableLabel,
                filterStats: {
                    before: rows.length,
                    after: filtered.kept,
                    removed: filtered.removed,
                    plan: filtered.plan,
                },
                assistantMessage:
                    (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                    buildSplitAssistantMessage(filtered.plan, {
                        tableLabel: command.tableLabel,
                        rowCount: filtered.kept,
                        sourceRowCount: rows.length,
                    }),
            });
        }

        if (actionNeedsSourceColumn(command.action) && !command.sourceColumn) {
            return res.json({
                ok: true,
                handled: true,
                command,
                assistantMessage:
                    (command.explanation ? `${command.explanation}\n\n` : '') +
                    formatColumnNotFoundMessage(headers, command.rawColumnHint),
            });
        }

        const values = rows.map((r) => String((r && r[command.sourceColumn]) ?? ''));
        const enriched = [];

        if (command.action === 'extract' || command.action === 'clean_source') {
            const fields =
                command.extractFields?.length > 0
                    ? command.extractFields
                    : inferExtractFieldsFromMessage(message);
            const stripTargets = stripTargetsFromFields(fields);
            const doStrip =
                command.action === 'clean_source' || command.stripFromSource;
            const onlyClean = command.action === 'clean_source';

            for (let i = 0; i < values.length; i++) {
                const text = values[i];
                const extracted = applyExtractFields(text, fields);
                const valuesOut = onlyClean ? {} : { ...extracted };
                if (doStrip && command.sourceColumn) {
                    valuesOut[command.sourceColumn] = stripExtractedFromText(text, stripTargets);
                }
                enriched.push({ index: i, values: valuesOut });
            }

            const newCols = onlyClean
                ? []
                : fields.map((f) => f.target_column);
            const stripNote = doStrip ? ` Очистила текст в «${command.sourceColumn}».` : '';
            const colsNote = newCols.length
                ? `Добавила колонки: ${newCols.join(', ')}. Прокрути таблицу вправо.`
                : '';
            console.log(
                `[result-table-action] ${command.action} done ${Date.now() - reqStarted}ms cols=${newCols.join(',') || '-'} strip=${doStrip}`
            );
            return res.json({
                ok: true,
                handled: true,
                command: { ...command, extractFields: fields },
                enriched,
                meta: { planner, fields, stripFromSource: doStrip },
                assistantMessage:
                    (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                    `Готово: ${colsNote}${stripNote}`.trim(),
            });
        }

        if (command.action === 'classify') {
            console.log(`[result-table-action] classify start unique~${new Set(values.filter(Boolean)).size}`);
            const threshold = Number.isFinite(options.threshold) ? Number(options.threshold) : command.threshold || 0.7;
            const auditorRule = String(options.auditorRule || command.auditorRule || '').trim();
            const maxUnique = Number.isFinite(options.maxUnique) ? Number(options.maxUnique) : 80;
            const batch = await classifyBatchUnique(values, { threshold, auditorRule, maxUnique });
            const classes = batch.results || [];
            for (let i = 0; i < classes.length; i++) {
                enriched.push({
                    index: i,
                    values: {
                        asset_class: classes[i].class,
                        asset_confidence: classes[i].confidence,
                        asset_reason: classes[i].reason,
                    },
                });
            }
            const truncNote = batch.truncated
                ? ` (лимит: классифицировано ${batch.uniqueClassified} уникальных значений)`
                : '';
            console.log(
                `[result-table-action] classify done ${Date.now() - reqStarted}ms unique=${batch.uniqueClassified} truncated=${batch.truncated}`
            );
            return res.json({
                ok: true,
                handled: true,
                command,
                enriched,
                meta: { uniqueClassified: batch.uniqueClassified, truncated: batch.truncated, auditorRule, planner },
                assistantMessage:
                    (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                    `Готово: «${command.sourceColumn}» → asset_class, asset_confidence, asset_reason.${truncNote}`,
            });
        }

        res.json({ ok: true, handled: false, command });
    } catch (err) {
        console.error('[result-table-action] error', err.message);
        res.status(500).json({ ok: false, handled: false, error: err.message });
    }
});

router.post('/ai/enrich-column', async (req, res) => {
    try {
        const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
        const sourceColumn = String(req.body.sourceColumn || '').trim();
        const mode = String(req.body.mode || '').trim().toLowerCase();
        const options = typeof req.body.options === 'object' && req.body.options ? req.body.options : {};

        if (!sourceColumn) {
            return res.status(400).json({ error: 'sourceColumn обязателен' });
        }
        if (!['extract', 'classify'].includes(mode)) {
            return res.status(400).json({ error: 'mode: extract | classify' });
        }

        const values = rows.map((r) => String((r && r[sourceColumn]) ?? ''));
        const enriched = [];

        if (mode === 'extract') {
            for (let i = 0; i < values.length; i++) {
                enriched.push({
                    index: i,
                    values: {
                        date_extracted: extractDate(values[i]),
                        address_extracted: extractAddress(values[i]),
                    },
                });
            }
        } else {
            const threshold = Number.isFinite(options.threshold) ? Number(options.threshold) : 0.7;
            const auditorRule = String(options.auditorRule || '').trim();
            const maxUnique = Number.isFinite(options.maxUnique) ? Number(options.maxUnique) : 80;
            const batch = await classifyBatchUnique(values, { threshold, auditorRule, maxUnique });
            const classes = batch.results || [];
            for (let i = 0; i < classes.length; i++) {
                enriched.push({
                    index: i,
                    values: {
                        asset_class: classes[i].class,
                        asset_confidence: classes[i].confidence,
                        asset_reason: classes[i].reason,
                    },
                });
            }
            return res.json({
                ok: true,
                mode,
                sourceColumn,
                rowCount: rows.length,
                enriched,
                meta: {
                    uniqueClassified: batch.uniqueClassified,
                    truncated: batch.truncated,
                    auditorRule: auditorRule || null,
                },
            });
        }

        res.json({
            ok: true,
            mode,
            sourceColumn,
            rowCount: rows.length,
            enriched,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/ai/resolve-answer', express.json(), async (req, res) => {
    try {
        const { userText, question, layoutMeta } = req.body || {};
        if (!userText || !question) {
            return res.status(400).json({ error: 'Нужны userText и question' });
        }
        const resolved = await resolveAnswerFromText({
            userText: String(userText),
            question,
            layoutMeta: layoutMeta || null,
            useLlm: req.body?.useLlm !== false,
        });
        if (!resolved) {
            return res.json({ ok: false, resolved: null });
        }
        res.json({ ok: true, resolved });
    } catch (err) {
        console.error('/api/ai/resolve-answer:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/ai/converse', async (req, res) => {
    try {
        const message = String(req.body.message || '').trim();
        if (!message) return res.status(400).json({ error: 'Нужен message' });

        let messages = [];
        let uiContext = null;
        try {
            messages = parseJsonField(req.body.messages, []);
            uiContext = parseJsonField(req.body.uiContext, null);
        } catch (e) {
            return res.status(400).json({ error: 'messages/uiContext: некорректный JSON' });
        }

        const chatSessionId = parseInt(req.body.chatSessionId || req.body.chat_session_id, 10) || null;
        const projectId = parseInt(req.body.projectId || req.body.project_id, 10) || null;
        const activeSnapshotId = parseInt(req.body.activeSnapshotId || req.body.active_snapshot_id, 10) || null;

        const projectPack = await buildProjectContextPack({
            chatStore: chatSessionStore,
            snapshotStore,
            chatSessionId,
            projectId,
            activeSnapshotId,
        });
        const uiPack = buildUiContextFallback(uiContext);
        let fullContext = mergeContextPacks(projectPack, uiPack);

        const dialogMessages = messages.length
            ? messages
            : [{ role: 'user', content: message }];

        let queryResult = null;
        let queryPlanner = null;

        const { looksLikeReconcileIntent } = require('./reconcile_intent');
        const { executeReconcileFromMessage } = require('./reconcile_flow');
        if ((projectId || chatSessionId) && looksLikeReconcileIntent(message)) {
            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            const reconcileOut = await executeReconcileFromMessage({
                message,
                snapshotStore,
                chatSessionStore,
                auditorSlug: auditor?.slug || 'martin',
                projectId,
                chatSessionId,
                activeSnapshotId,
            });

            if (reconcileOut.needsClarification) {
                await logChatExchange({
                    chatSessionId,
                    projectId,
                    snapshotId: activeSnapshotId,
                    userMessage: message,
                    assistantMessage: reconcileOut.assistantMessage,
                });
                return res.json({
                    ok: true,
                    assistantMessage: reconcileOut.assistantMessage,
                    reconcileClarification: true,
                    questions: reconcileOut.questions || [],
                    catalog: reconcileOut.catalog || null,
                });
            }

            if (reconcileOut.ok && reconcileOut.reconcileOperation) {
                if (chatSessionId && reconcileOut.snapshotId) {
                    await maybeLinkSnapshotToChat({
                        chatSessionId,
                        snapshotId: reconcileOut.snapshotId,
                        label: reconcileOut.plan?.reportLabel
                            ? `${reconcileOut.plan.reportLabel}: ${reconcileOut.plan.left?.label} ↔ ${reconcileOut.plan.right?.label}`
                            : undefined,
                        projectId,
                    });
                }
                await logChatExchange({
                    chatSessionId,
                    projectId,
                    snapshotId: reconcileOut.snapshotId,
                    userMessage: message,
                    assistantMessage: reconcileOut.assistantMessage,
                });
                return res.json({
                    ok: true,
                    assistantMessage: reconcileOut.assistantMessage,
                    reconcileOperation: true,
                    snapshotId: reconcileOut.snapshotId,
                    headers: reconcileOut.headers,
                    tableMeta: reconcileOut.tableMeta,
                    summary: reconcileOut.summary,
                    plan: reconcileOut.plan,
                });
            }

            if (reconcileOut.assistantMessage) {
                await logChatExchange({
                    chatSessionId,
                    projectId,
                    snapshotId: activeSnapshotId,
                    userMessage: message,
                    assistantMessage: reconcileOut.assistantMessage,
                });
                return res.json({
                    ok: true,
                    assistantMessage: reconcileOut.assistantMessage,
                });
            }
        }

        if (activeSnapshotId) {
            const snap = await snapshotStore.getSnapshot(activeSnapshotId);
            const samplePage = await snapshotStore.fetchRowsPage(activeSnapshotId, { page: 1, limit: 20 });
            const headers = snap?.headers || uiContext?.headers || [];
            const sampleRows = (samplePage?.rows || []).map((r) => {
                const copy = { ...r };
                delete copy.__rowIndex;
                return copy;
            });

            const { looksLikeTableMutationIntent } = require('./table_work_intent');
            if (snap?.status === 'ready' && looksLikeTableMutationIntent(message)) {
                const opResult = await applySnapshotOperation(snapshotStore, activeSnapshotId, {
                    message,
                    options: { chatHistory: dialogMessages, useLlm: shouldUseLlmReply() },
                });
                if (opResult.handled) {
                    const freshSnap = await snapshotStore.getSnapshot(activeSnapshotId);
                    await logChatExchange({
                        chatSessionId,
                        projectId,
                        snapshotId: activeSnapshotId,
                        userMessage: message,
                        assistantMessage: opResult.assistantMessage,
                    });
                    return res.json({
                        ok: true,
                        assistantMessage: opResult.assistantMessage,
                        tableOperation: true,
                        headers: opResult.headers || freshSnap?.headers || headers,
                        newColumns: opResult.newColumns || null,
                        command: opResult.command || null,
                        planner: opResult.planner || null,
                        contextUsed: Boolean(fullContext.trim()),
                    });
                }
                if (!opResult.command?.action) {
                    fullContext = mergeContextPacks(
                        fullContext,
                        '[Система: запрос похож на команду к таблице, но план не построен. НЕ утверждай что колонка добавлена или фильтр применён. Скажи что не разобрала команду и предложи переформулировать.]'
                    );
                }
            }

            const planned = await planTableQuery({
                message,
                headers,
                rows: sampleRows,
                chatHistory: dialogMessages,
                useLlm: shouldUseLlmReply(),
            });
            queryPlanner = planned.planner;
            if (planned.plan?.action === 'aggregate') {
                queryResult = await executeTableQuery(snapshotStore, activeSnapshotId, planned.plan);
                if (queryResult?.ok) {
                    fullContext = mergeContextPacks(fullContext, formatQueryResultForLlm(queryResult));
                }
            }
        }

        const fallbackMessage = chatSessionId
            ? 'Не удалось связаться с ИИ. Попробуй ещё раз или проверь ключ в .env.'
            : 'Привет! Я Martin. Могу поболтать и помочь с аудитом — прикрепи файл или открой чат сессии.';

        let assistantMessage;
        const templateAnswer = queryResult?.ok ? formatQueryResultMessage(queryResult) : null;

        if (templateAnswer && !queryResult.groups?.length) {
            assistantMessage = templateAnswer;
        } else if (shouldUseLlmReply()) {
            assistantMessage = await generateMartinConverseReply({
                messages: dialogMessages,
                context: fullContext,
                fallbackMessage: templateAnswer || fallbackMessage,
            });
        } else {
            assistantMessage =
                templateAnswer ||
                `${fallbackMessage}\n\nТы спросил: «${message}». ` +
                    (uiContext?.headers?.length
                        ? `Вижу таблицу: ${uiContext.headers.slice(0, 6).join(', ')}…`
                        : 'Прикрепи файл — разберём.');
        }

        await logChatExchange({
            chatSessionId,
            projectId,
            snapshotId: activeSnapshotId,
            userMessage: message,
            assistantMessage,
        });

        res.json({
            ok: true,
            assistantMessage,
            contextUsed: Boolean(fullContext.trim()),
            queryResult: queryResult?.ok ? queryResult : null,
            queryPlanner,
        });
    } catch (err) {
        console.error('/api/ai/converse:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/ai/chat', upload.fields([{ name: 'file' }, { name: 'target' }]), fixUploadNamesMiddleware, async (req, res) => {
    try {
        const profileFamily =
            String(req.body.profileFamily || req.body.parserType || 'os').toLowerCase() === 'uk'
                ? 'uk'
                : 'os';
        let messages;
        let currentRule;
        try {
            messages = parseJsonField(req.body.messages, []);
            currentRule = parseJsonField(req.body.currentRule, null);
        } catch (e) {
            return res.status(400).json({ error: 'messages/currentRule: некорректный JSON' });
        }

        let layoutAnalysis;
        let orchestratorAnswers;
        try {
            layoutAnalysis = parseJsonField(req.body.layoutAnalysis, null);
            orchestratorAnswers = parseJsonField(req.body.orchestratorAnswers, {});
        } catch (e) {
            return res.status(400).json({ error: 'layoutAnalysis/orchestratorAnswers: некорректный JSON' });
        }

        const sourceFile = req.files?.file?.[0];
        const targetUpload = req.files?.target?.[0];

        const out = await processAiChat({
            profileFamily,
            messages,
            currentRule,
            file: sourceFile,
            sheetName: req.body.sheetName,
            layoutAnalysis,
            targetFile: targetUpload,
            scenarioId: req.body.scenarioId || null,
            orchestratorAnswers,
            projectId: req.body.project_id || req.body.projectId || null,
            chatSessionId: req.body.chatSessionId || req.body.chat_session_id || null,
        });
        res.status(out.status).json(out.body);
    } catch (err) {
        console.error('/api/ai/chat:', err);
        res.status(500).json({ error: err.message });
    }
});

router.post('/ai/generate-rule-from-file', upload.single('file'), fixUploadNamesMiddleware, async (req, res) => {
    const { prompt } = req.body;
    const file = req.file;

    if (!prompt || !file) {
        return res.status(400).json({ error: 'Необходимы prompt и файл' });
    }

    try {
        const out = await processAiChat({
            profileFamily: 'uk',
            messages: [{ role: 'user', content: prompt }],
            currentRule: null,
            file,
        });
        if (out.status !== 200) {
            return res.status(out.status).json(out.body);
        }
        res.json({
            rule: out.body.rule,
            preview: out.body.preview,
            assistantMessage: out.body.assistantMessage,
            parsePreview: out.body.parsePreview,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

registerPdfParseScenarioRoutes(router, { pool, maybeLinkSnapshotToChat });

registerInboxRoutes(router, {
    pool,
    snapshotStore,
    maybeLinkSnapshotToChat,
    logChatExchange,
    runBatchStartFromUploads,
});

registerReconcileRoutes(router, {
    pool,
    snapshotStore,
    chatSessionStore,
    maybeLinkSnapshotToChat,
});

module.exports = router;
module.exports.processAiChat = processAiChat;
module.exports.runMartinSession = runMartinSession;
module.exports.runBatchStartFromUploads = runBatchStartFromUploads;
module.exports.bootstrapRuleFromUserMessage = bootstrapRuleFromUserMessage;
