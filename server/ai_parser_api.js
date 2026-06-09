const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
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
const { listParserProfiles, getParserProfile, resolveParserDispatch } = require('./parser_registry');
const { loadTargetRows, comparePreviewToTarget } = require('./compare_target');
const { applyTargetToRule, inferColumnsFromTargetHeaders } = require('./target_rule_infer');
const { loadExample } = require('./ai_prompts');
const { applyV2HintsFromUserMessage, bootstrapRuleFromUserMessage } = require('./rule_hints');
const {
    buildTemplateMessage,
    generateMartinReply,
    buildLlmContext,
} = require('./assist_martin');
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
    classifyBatchUnique,
} = require('./cell_enrich');
const { parseResultTableCommand } = require('./result_table_commands');
const { mergeResultTableCommand } = require('./result_table_resolve');
const { planResultTableActionWithLlm } = require('./result_table_llm');

const { buildSessionPlan, applyOrchestratorToLayoutMeta } = require('./orchestrator');
const { planTreeRuleWithLlm, isTreeIntentMessage } = require('./tree_rule_llm');
const { detectSourceKind } = require('./file_dispatch');
const { parse1cTsvExport } = require('./parse_1c_tsv');
const { resolveUpload, shouldRequireTreeConfirm } = require('./scenario_router');
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
const { shouldParseAllSheets, parseAllExcelSheets } = require('./multi_sheet_martin');
const { applyAutostartDefaults } = require('./autostart_defaults');
const { PREVIEW_ROWS_CLIENT } = require('./parse_snapshot_import');

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const upload = multer({ storage: multer.memoryStorage() });
const snapshotStore = createParseSnapshotStore(pool);
const chatSessionStore = createChatSessionStore(pool);

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

async function logChatExchange({ chatSessionId, projectId, snapshotId, userMessage, assistantMessage }) {
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
        });
    }
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
    return process.env.MARTIN_USE_LLM_AUTOSTART === '1';
}

function buildText1cAutostartResponse(file, parsed, routed = {}) {
    const previewLimit = 200;
    const rows = parsed.rows.slice(0, previewLimit);
    const scenarioId = routed.scenarioId || (parsed.profile === 'deals_registry_tsv' ? 'deals_registry_tsv' : 'card_90_tsv');
    const scenarioName = routed.scenarioName || scenarioDisplayName(scenarioId);
    const parts = [
        `Разобрала **текстовую выгрузку 1С** — сценарий **${scenarioName}**.`,
        `Строк: **${parsed.rowCount}**.`,
    ];
    if (parsed.meta?.encoding && parsed.meta.encoding !== 'utf8') {
        parts.push(`Кодировка: ${parsed.meta.encoding}.`);
    }
    if (parsed.warnings?.length) parts.push(parsed.warnings.join(' '));

    return {
        ok: true,
        sourceKind: 'text_1c',
        parserProfile: 'kseniya',
        rule: null,
        snapshotId: null,
        parsePreview: {
            headers: parsed.headers,
            rows,
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
            previewText: rows
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
        previewTruncated: parsed.rowCount > previewLimit,
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
        routed = resolveUpload({
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

    // Autostart: на первом проходе — сразу полный парс, без черновика и вопросов
    if ((plan.needsUserInput || mustConfirmTree) && !isFirstPass) {
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

        const assistantMessage = shouldUseLlmOnAutostart()
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
        return { status: 400, body: { error: 'Нужен Excel-файл' } };
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
    await logChatExchange({
        chatSessionId: parsedChatSessionId,
        projectId,
        snapshotId: session.snapshotId || null,
        userMessage: lastUser?.content || '',
        assistantMessage: session.assistantMessage,
    });

    return {
        status: 200,
        body: {
            rule: session.rule,
            ruleSchemaVersion: 2,
            ruleDiff: session.ruleDiff,
            warnings: session.warnings,
            assistantMessage: session.assistantMessage,
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

// --- Проекты ---

router.get('/projects', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM projects ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/projects', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Имя проекта обязательно' });
    try {
        const result = await pool.query('INSERT INTO projects (name) VALUES ($1) RETURNING *', [name]);
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
        const snap = await snapshotStore.getSnapshot(parseInt(req.params.id, 10));
        if (!snap) return res.status(404).json({ error: 'Снимок не найден' });
        res.json(snap);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/parse/snapshots/:id/rows', async (req, res) => {
    try {
        const snapshotId = parseInt(req.params.id, 10);
        const page = parseInt(req.query.page || '1', 10);
        const limit = parseInt(req.query.limit || '200', 10);
        const data = await snapshotStore.fetchRowsPage(snapshotId, { page, limit });
        if (!data) return res.status(404).json({ error: 'Снимок не найден' });
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/parse/snapshots/:id', async (req, res) => {
    try {
        const snapshotId = parseInt(req.params.id, 10);
        const snap = await snapshotStore.getSnapshot(snapshotId);
        if (!snap) return res.status(404).json({ error: 'Снимок не найден' });
        await snapshotStore.deleteSnapshot(snapshotId);
        res.json({ ok: true });
    } catch (err) {
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

        let chatHistory = Array.isArray(req.body.messages) ? req.body.messages : [];
        const chatSessionId = req.body.chatSessionId ? parseInt(req.body.chatSessionId, 10) : null;
        if (chatSessionId && !chatHistory.length) {
            chatHistory = await chatSessionStore.getChatMessages(chatSessionId, 20);
        }

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

        if (req.body.logChat && message) {
            const snap = await snapshotStore.getSnapshot(snapshotId);
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
        const chats = await chatSessionStore.listChatSessions(projectId);
        res.json({ chats });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/projects/:projectId/chats', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        const title = String(req.body.title || 'Новый чат').trim() || 'Новый чат';
        const chat = await chatSessionStore.createChatSession(projectId, title);
        res.status(201).json({ chat });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/projects/:projectId/chats', async (req, res) => {
    try {
        const projectId = parseInt(req.params.projectId, 10);
        await chatSessionStore.deleteAllChatSessions(projectId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/chats/:chatId', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        const chat = await chatSessionStore.getChatSession(chatId);
        if (!chat) return res.status(404).json({ error: 'Чат не найден' });
        await chatSessionStore.deleteChatSession(chatId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/chats/:chatId', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        const chat = await chatSessionStore.getChatSession(chatId);
        if (!chat) return res.status(404).json({ error: 'Чат не найден' });
        const snapshots = await chatSessionStore.listChatSnapshots(chatId);
        const messages = await chatSessionStore.getChatMessages(chatId);
        res.json({ chat, snapshots, messages });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/chats/:chatId/messages', async (req, res) => {
    try {
        const chatId = parseInt(req.params.chatId, 10);
        const messages = await chatSessionStore.getChatMessages(chatId);
        res.json({ messages });
    } catch (err) {
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
            const files = uploaded;
            if (!files.length) return res.status(400).json({ error: 'Нужен хотя бы один файл' });

            let orchestratorAnswers = {};
            try {
                orchestratorAnswers = parseJsonField(req.body.orchestratorAnswers, {}) || {};
            } catch {
                orchestratorAnswers = {};
            }

            const userMessage = String(req.body.userMessage || '').trim();
            const projectId = req.body.project_id || req.body.projectId || null;
            const chatSessionId = req.body.chatSessionId
                ? parseInt(req.body.chatSessionId, 10)
                : null;
            const scenarioId =
                req.body.scenarioId ||
                orchestratorAnswers.scenarioId ||
                detectBatchScenario(files, userMessage, null);

            if (isOpifScenario(scenarioId)) {
                const parsed = await parseOpifBatch(
                    files,
                    scenarioId,
                    userMessage,
                    req.body.filePrefix
                );
                if (!parsed.rows.length) {
                    return res.status(422).json({
                        error: (parsed.errors || ['Нет строк после парса']).join('; '),
                        warnings: parsed.warnings,
                    });
                }

                const labelName =
                    files.length === 1
                        ? fileNameOf(files[0])
                        : `${scenarioId}_${files.length}files`;

                const snapshotId = await snapshotStore.createSnapshot({
                    projectId: projectId ? parseInt(projectId, 10) : null,
                    sourceFileName: labelName,
                    sheetName: null,
                    scenarioId,
                    headers: parsed.headers,
                    status: 'parsing',
                });

                const rowCount = await snapshotStore.importParsedRows(
                    snapshotId,
                    parsed.headers,
                    parsed.rows
                );

                const assistantMessage = buildOpifAssistantMessage(scenarioId, {
                    filesProcessed: parsed.filesProcessed,
                    rowCount,
                    prefix: req.body.filePrefix,
                    warnings: parsed.warnings,
                });

                if (chatSessionId) {
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

                const previewRows = parsed.rows.slice(0, PREVIEW_ROWS_CLIENT);
                return res.json({
                    ok: true,
                    scenarioId,
                    scenarioName: scenarioDisplayName(scenarioId),
                    sourceKind: scenarioId === 'opif_depo' ? 'pdf' : 'excel',
                    snapshotId,
                    parsePreview: {
                        headers: parsed.headers,
                        rows: previewRows,
                        rowCount,
                    },
                    warnings: parsed.warnings,
                    assistantMessage,
                    staged: false,
                    needsUserInput: false,
                });
            }

            if (files.length > 1) {
                return res.status(422).json({
                    error: 'Несколько Excel-файлов без OPIF-сценария пока не поддержаны. Укажи «депо» или «брокер».',
                });
            }

            const sourceFile = files[0];
            const targetFile = req.files?.target?.[0];
            let sheetName = req.body.sheetName;

            let savedRules = [];
            if (projectId) savedRules = await fetchSavedRulesByProject(projectId);

            const { sheetNames: workbookSheets, defaultSheet } = listSheetNames(sourceFile.buffer);
            orchestratorAnswers = applyAutostartDefaults(
                analyzeLayout(sourceFile.buffer, sheetName || defaultSheet, {
                    fileName: sourceFile.originalname,
                }),
                orchestratorAnswers
            );

            const useAllSheets =
                shouldParseAllSheets({
                    files,
                    scenarioId,
                    parseAllSheets: req.body.parseAllSheets,
                    orchestratorAnswers,
                    sheetName,
                }) ||
                (workbookSheets.length > 1 &&
                    !sheetName &&
                    !orchestratorAnswers?.sheetName &&
                    !String(orchestratorAnswers?.pick_tree_flatten || '').startsWith('scenario:') &&
                    !scenarioId);

            if (useAllSheets) {
                const multi = await parseAllExcelSheets({
                    pool,
                    file: sourceFile,
                    targetFile,
                    projectId,
                    savedRules,
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
                    await logChatExchange({
                        chatSessionId,
                        projectId,
                        snapshotId: multi.primary?.snapshotId,
                        userMessage: userMessage || '(старт парса)',
                        assistantMessage: multi.assistantMessage,
                    });
                }

                const primary = multi.primary;
                return res.json({
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
                    warnings: multi.warnings,
                    assistantMessage: multi.assistantMessage,
                    skippedSheets: multi.skipped,
                    needsUserInput: false,
                    needsScenarioChoice: false,
                    previewIsTentative: false,
                    userMessage,
                    staged: false,
                });
            }

            const routed = resolveUpload({
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

            if (routed.route === 'text') {
                const session = buildText1cAutostartResponse(sourceFile, routed.textParse, routed);
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
                await logChatExchange({
                    chatSessionId,
                    projectId,
                    snapshotId: session.snapshotId,
                    userMessage: userMessage || '(старт парса)',
                    assistantMessage: session.assistantMessage,
                });
            }

            return res.json({ ...session, userMessage, staged: false });
        } catch (err) {
            console.error('[batch-start] error', err.message);
            res.status(500).json({ ok: false, error: err.message });
        }
    }
);

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

        const routed = resolveUpload({
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

        if (routed.route === 'text') {
            const session = buildText1cAutostartResponse(sourceFile, routed.textParse, routed);
            const chatSessionId = req.body.chatSessionId || req.body.chat_session_id;
            const parsedChatSessionId = chatSessionId ? parseInt(chatSessionId, 10) : null;
            if (parsedChatSessionId && session.assistantMessage) {
                await chatSessionStore.appendChatMessage({
                    chatSessionId: parsedChatSessionId,
                    projectId: req.body.project_id || req.body.projectId || null,
                    snapshotId: null,
                    role: 'assistant',
                    content: session.assistantMessage,
                });
            }
            return res.json(session);
        }

        let savedRules = [];
        const projectId = req.body.project_id || req.body.projectId;
        if (projectId) savedRules = await fetchSavedRulesByProject(projectId);

        const session = await runMartinSession({
            file: sourceFile,
            targetFile,
            layoutMeta: routed.layoutMeta,
            currentRule: null,
            userMessage: '',
            messages: [],
            isFirstPass: true,
            scenarioId: req.body.scenarioId || routed.scenarioId || null,
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
        const regexCmd = parseResultTableCommand(message, headers);
        const skipLlm =
            regexCmd.action === 'clean_source' ||
            regexCmd.stripFromSource ||
            (regexCmd.action === 'filter_rows' && regexCmd.filters?.length) ||
            (regexCmd.action === 'extract' && /(инвентар|номер).*(дат|дату)|(дат|дату).*(инвентар|номер)/i.test(message));

        let plan = null;
        if (options.useLlm !== false && message && !skipLlm) {
            try {
                plan = await planResultTableActionWithLlm({ message, headers, rows });
            } catch (e) {
                plan = null;
            }
        }

        const command = mergeResultTableCommand({ message, headers, plan, regexCmd });
        const planner = command.planner || (plan ? 'llm' : 'regex');

        console.log(
            `[result-table-action] planner=${planner} action=${command.action} column=${command.sourceColumn || '-'} rows=${rows.length} msg=${message.slice(0, 80)}`
        );

        if (!command.action) {
            console.log(`[result-table-action] unhandled ${Date.now() - reqStarted}ms`);
            return res.json({ ok: true, handled: false, command });
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

        if (!command.sourceColumn) {
            return res.json({
                ok: true,
                handled: true,
                command,
                assistantMessage:
                    (command.explanation ? `${command.explanation}\n\n` : '') +
                    'Не нашла колонку. Напиши: «колонка ОС» (точное имя из заголовка таблицы).',
            });
        }

        const values = rows.map((r) => String((r && r[command.sourceColumn]) ?? ''));
        const enriched = [];

        if (command.action === 'extract' || command.action === 'clean_source') {
            const fields =
                command.extractFields?.length > 0 ? command.extractFields : defaultExtractFields();
            const doStrip =
                command.action === 'clean_source' || command.stripFromSource;
            const onlyClean = command.action === 'clean_source';

            for (let i = 0; i < values.length; i++) {
                const text = values[i];
                const extracted = applyExtractFields(text, fields);
                const valuesOut = onlyClean ? {} : { ...extracted };
                if (doStrip && command.sourceColumn) {
                    valuesOut[command.sourceColumn] = stripExtractedFromText(text);
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

module.exports = router;
module.exports.processAiChat = processAiChat;
module.exports.runMartinSession = runMartinSession;
module.exports.applyV2HintsFromUserMessage = applyV2HintsFromUserMessage;
module.exports.bootstrapRuleFromUserMessage = bootstrapRuleFromUserMessage;
