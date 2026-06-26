const { probeDocument } = require('./document_probe');
const { getCachedRule, setCachedRule, buildFileLayoutFingerprint } = require('./rule_cache');
const { synthExtractionRuleWithLlm, executeRule } = require('./rule_synth_llm');
const { tryParseUpdPdf } = require('../parse_upd_pdf');
const {
    isDocumentScanEnabled,
    isLikelyScanPdf,
    isMachineReadablePdf,
    extractScannedDocument,
    mimeTypeForScanFile,
    buildScanTableFromExtraction,
} = require('../document_scan_llm');
const { orchestrateSheetParse, buildSheetContext } = require('../sheet_parse_orchestrator');
const { scenarioDisplayName } = require('../scenarios/catalog');
const { extractPdfTablesFromLines } = require('./pdf_table_extract');
const { extractTableGridFromPdf, isReasonableGridTable } = require('./pdfjs_table_grid_extract');
const {
    extractBrokerPdfSectionTables,
    shouldUseMultiTableBrokerParse,
    resolveSectionsFromMessage,
} = require('./pdf_broker_sections');
const { createParseSnapshotStore } = require('../parse_snapshot_store');
const { shouldDelegateToOpifDepo } = require('../pdf_probe');
const { resolvePdfParseScenario, extractWithPdfParseScenario } = require('./resolve_pdf_parse_scenario');
const { diagnoseGridExtract } = require('./pdf_grid_diagnostics');
const { buildPdfParseValidationReport } = require('../pdf_parse_validation_report');
const { comparePdfDualExtract } = require('./pdf_dual_extract');
const {
    HIGH_CONFIDENCE,
    IMPORT_MIN_CONFIDENCE,
    GRID_MIN_CONFIDENCE,
    PDF_VALIDATION_STRICT,
} = require('../confidence_thresholds');

function applyForcedPdfKind(probe, orchestratorAnswers = {}) {
    const forced =
        orchestratorAnswers.pick_pdf_kind ||
        orchestratorAnswers.pdfKind ||
        null;
    if (!forced || probe.sourceKind !== 'pdf' || !probe.pdfProbe) return probe;

    const pdfProbe = {
        ...probe.pdfProbe,
        kind: forced,
        ambiguous: false,
        confidence: Math.max(probe.pdfProbe.confidence || 0.5, 0.82),
        userForcedKind: true,
    };
    return {
        ...probe,
        pdfProbe,
        layoutMeta: {
            ...(probe.layoutMeta || {}),
            pdfProbe,
        },
    };
}

async function importTableToSnapshot(pool, { file, projectId, scenarioId, headers, rows, sheetName = null }) {
    const store = createParseSnapshotStore(pool);
    const sid = await store.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: file.originalname,
        sheetName,
        scenarioId,
        headers,
        status: 'parsing',
    });
    const rowCount = await store.importParsedRows(sid, headers, rows);
    return {
        snapshotId: sid,
        parsePreview: { headers, rows: rows.slice(0, 200), rowCount },
        rowCount,
    };
}

function buildResponse(base) {
    const out = {
        ok: true,
        route: 'universal',
        sourceKind: base.sourceKind,
        scenarioId: base.scenarioId,
        scenarioName: base.scenarioName || scenarioDisplayName(base.scenarioId),
        confidence: base.confidence ?? 0.9,
        snapshotId: base.snapshotId || null,
        parsePreview: base.parsePreview || null,
        layoutMeta: base.layoutMeta || null,
        meta: base.meta || null,
        rule: base.rule || null,
        needsConfirm: Boolean(base.needsConfirm),
        warnings: base.warnings || [],
        assistantMessage: base.assistantMessage || '',
        structurePack: base.structurePack || null,
        engine: base.engine || 'unknown',
    };
    if (base.multiTable) out.multiTable = true;
    if (base.multiSheet) out.multiSheet = true;
    if (base.snapshots) out.snapshots = base.snapshots;
    if (base.sheetNames) out.sheetNames = base.sheetNames;
    if (base.scenarioResolution) out.scenarioResolution = base.scenarioResolution;
    if (base.gridDiagnostics) out.gridDiagnostics = base.gridDiagnostics;
    if (base.validationReport) out.validationReport = base.validationReport;
    if (base.needsScenarioChoice) out.needsScenarioChoice = true;
    if (base.candidates) out.candidates = base.candidates;
    return out;
}

function pdfKindCandidates(pdfProbe) {
    const alts = pdfProbe?.alternatives || [];
    const labels = {
        broker_report: 'Брокерский отчёт',
        depo: 'Выписка ДЕПО',
        upd_ediweb: 'УПД',
        unknown_pdf: 'Другой PDF',
    };
    if (alts.length) {
        return alts.map((a) => ({
            scenarioId: a.id,
            label: a.label || labels[a.id] || a.id,
            score: a.score,
            confidence: a.score ? Math.min(0.95, 0.4 + a.score * 0.12) : 0.4,
        }));
    }
    return [
        { scenarioId: 'broker_report', label: labels.broker_report, confidence: 0.5 },
        { scenarioId: 'depo', label: labels.depo, confidence: 0.4 },
        { scenarioId: 'upd_ediweb', label: labels.upd_ediweb, confidence: 0.4 },
    ];
}

function buildPdfAmbiguousResponse(probe, confidence) {
    const candidates = pdfKindCandidates(probe.pdfProbe);
    return buildResponse({
        sourceKind: 'pdf',
        scenarioId: 'unknown_pdf',
        confidence: confidence ?? probe.pdfProbe?.confidence ?? 0.35,
        layoutMeta: probe.layoutMeta,
        needsScenarioChoice: true,
        needsConfirm: false,
        candidates,
        engine: 'pdf_probe_ambiguous',
        assistantMessage:
            'Не могу однозначно определить тип PDF. Выбери: брокерский отчёт, выписка ДЕПО или УПД.',
    });
}

/**
 * @param {object} ctx
 * @param {object} params
 */
async function finalizePdfTable(ctx, params) {
    const {
        pool,
        file,
        projectId,
        probe,
        scenarioId,
        headers,
        rows,
        sheetName,
        confidence,
        meta,
        engine,
        gridDiagnostics,
        dualExtract,
        savedScenarioFound,
        expectedColumnCount,
        withScenario,
        baseResponse,
    } = params;

    const parsePreview = {
        headers,
        rows: (rows || []).slice(0, 200),
        rowCount: rows?.length || 0,
    };

    const validationReport = buildPdfParseValidationReport({
        preview: parsePreview,
        pdfProbe: probe.pdfProbe,
        gridDiagnostics,
        dualExtract,
        expectedColumnCount,
        savedScenarioFound,
    });

    const effectiveConfidence = Math.min(confidence ?? 0.9, gridDiagnostics?.confidence ?? confidence ?? 0.9);
    const shouldBlock =
        validationReport.blocksImport ||
        (PDF_VALIDATION_STRICT && validationReport.status === 'fail') ||
        (!savedScenarioFound && effectiveConfidence < IMPORT_MIN_CONFIDENCE && validationReport.status === 'fail');

    const needsConfirm =
        shouldBlock ||
        effectiveConfidence < IMPORT_MIN_CONFIDENCE ||
        validationReport.status === 'warn' ||
        validationReport.status === 'fail';

    if (shouldBlock) {
        const response = {
            sourceKind: 'pdf',
            scenarioId,
            confidence: effectiveConfidence,
            snapshotId: null,
            parsePreview,
            layoutMeta: probe.layoutMeta,
            meta,
            engine,
            gridDiagnostics,
            validationReport,
            needsConfirm: true,
            warnings: validationReport.checks.filter((c) => c.status !== 'pass').map((c) => c.detail || c.title),
            assistantMessage: `${validationReport.summary}. Подправь колонки или подтверди черновик.`,
            ...baseResponse,
        };
        return withScenario ? withScenario(response) : buildResponse(response);
    }

    const imported = await importTableToSnapshot(pool, {
        file,
        projectId,
        scenarioId,
        headers,
        rows,
        sheetName,
    });

    const response = {
        sourceKind: 'pdf',
        scenarioId,
        confidence: effectiveConfidence,
        snapshotId: imported.snapshotId,
        parsePreview: imported.parsePreview,
        layoutMeta: probe.layoutMeta,
        meta,
        engine,
        gridDiagnostics,
        validationReport,
        needsConfirm,
        assistantMessage: baseResponse?.assistantMessage,
    };
    return withScenario ? withScenario(response) : buildResponse(response);
}

async function parseExcelUniversal(ctx) {
    const { pool, file, sheetName, projectId, probe } = ctx;
    const result = await orchestrateSheetParse({
        pool,
        file,
        sheetName: sheetName || probe.layoutMeta?.sheetName,
        projectId,
    });
    if (result?.ok && result.snapshotId) {
        return buildResponse({
            sourceKind: 'excel',
            scenarioId: result.scenarioId || probe.layoutMeta?.recommended?.profile_hint,
            confidence: probe.layoutMeta?.recommended?.confidence,
            snapshotId: result.snapshotId,
            parsePreview: result.parsePreview,
            layoutMeta: probe.layoutMeta,
            engine: result.profileId || 'sheet_orchestrator',
            assistantMessage: `Разобрала лист: **${result.rowCount}** строк.`,
        });
    }
    return null;
}

async function parseScanWithVision(ctx) {
    const { pool, file, projectId, userMessage } = ctx;
    if (!isDocumentScanEnabled()) return null;
    if (!userMessage?.trim()) return null;

    const mimeType = mimeTypeForScanFile(file.originalname || file.name || '');
    const extracted = await extractScannedDocument({
        buffer: file.buffer,
        mimeType,
        fileName: file.originalname || file.name || 'scan',
        userMessage,
    });

    const { headers, rows } = buildScanTableFromExtraction(extracted, userMessage);

    if (!rows.length && !extracted.fullText) {
        return buildResponse({
            sourceKind: ctx.sourceKind || 'pdf',
            scenarioId: 'document_scan',
            confidence: extracted.confidence || 0.2,
            needsConfirm: true,
            engine: 'document_scan_llm',
            assistantMessage:
                extracted.notes ||
                'Скан прочитала слабо — уточни в чате, какие поля нужны, или пришли более чёткий файл.',
        });
    }

    const imported = await importTableToSnapshot(pool, {
        file,
        projectId,
        scenarioId: 'document_scan',
        headers,
        rows,
    });

    return buildResponse({
        sourceKind: ctx.sourceKind || 'pdf',
        scenarioId: 'document_scan',
        confidence: Math.max(0.5, extracted.confidence || 0.7),
        snapshotId: imported.snapshotId,
        parsePreview: imported.parsePreview,
        meta: {
            documentKind: extracted.documentKind,
            fields: extracted.fields,
            visionModel: process.env.VISION_MODEL || null,
        },
        engine: 'document_scan_llm',
        needsConfirm: (extracted.confidence || 0) < 0.75,
        assistantMessage: `Скан (vision): **${imported.rowCount}** строк. Тип: **${extracted.documentKind || 'other'}**.${extracted.notes ? ` ${extracted.notes}` : ''}`,
    });
}

async function tryVisionScanFallback(ctx) {
    const { pool, file, projectId, probe, userMessage } = ctx;
    if (!isDocumentScanEnabled()) return null;
    if (!userMessage?.trim()) return null;
    if (!isLikelyScanPdf(probe.pdfProbe) && !probe.pdfProbe?.isLikelyScan) return null;

    return parseScanWithVision({
        pool,
        file,
        projectId,
        userMessage,
        sourceKind: 'pdf',
    });
}

async function parsePdfUniversal(ctx) {
    const { pool, file, projectId, probe, userMessage } = ctx;
    const kind = probe.pdfProbe?.kind;
    const confidence = probe.pdfProbe?.confidence ?? 0.5;

    if (
        !probe.pdfProbe?.userForcedKind &&
        (probe.pdfProbe?.ambiguous || (kind === 'unknown' && (probe.pdfProbe?.alternatives?.length || 0) >= 2))
    ) {
        return buildPdfAmbiguousResponse(probe, confidence);
    }

    // 1) Машиночитаемый PDF — сначала известные сценарии и текстовые правила
    if (kind === 'upd_ediweb' && confidence >= 0.7) {
        const upd = await tryParseUpdPdf({ pool, file, projectId });
        if (upd?.ok) {
            return buildResponse({
                sourceKind: 'pdf',
                scenarioId: 'upd_ediweb',
                confidence,
                snapshotId: upd.snapshotId,
                parsePreview: upd.parsePreview,
                layoutMeta: probe.layoutMeta,
                meta: upd.meta,
                engine: 'parse_upd_pdf',
                needsConfirm: upd.needsConfirm,
                assistantMessage: `УПД: **${upd.rowCount}** позиций в таблице.`,
            });
        }
        if (upd && !upd.ok && upd.parsePreview) {
            return buildResponse({
                sourceKind: 'pdf',
                scenarioId: 'upd_ediweb',
                confidence: confidence * 0.8,
                parsePreview: upd.parsePreview,
                layoutMeta: probe.layoutMeta,
                needsConfirm: true,
                warnings: [upd.error],
                engine: 'parse_upd_pdf',
                assistantMessage: `${upd.error}. Проверь черновик и подтверди.`,
            });
        }
    }

    if (
        shouldDelegateToOpifDepo({
            pdfProbe: probe.pdfProbe,
            userMessage,
            fileName: file.originalname || file.name || '',
        })
    ) {
        return { ok: false, delegateDepo: true, routed: { scenarioId: 'opif_depo', confidence } };
    }

    const pdfScenarioId = kind === 'broker_report' ? 'broker_pdf' : 'pdf_extracted';
    const machineReadable = isMachineReadablePdf(probe.pdfProbe);

    let scenarioResolution = null;
    let bestPdfScenario = null;
    if (machineReadable && pool) {
        try {
            const resolved = await resolvePdfParseScenario(pool, file.buffer, probe.pdfProbe, {
                projectId,
            });
            scenarioResolution = {
                catalogScenarioId: resolved.catalogScenarioId,
                catalogConfidence: resolved.catalogConfidence,
                parseScenario: resolved.parseScenario,
            };
            bestPdfScenario = resolved.bestScenario;
        } catch {
            /* non-fatal */
        }
    }

    const withScenario = (base) =>
        buildResponse({
            ...base,
            scenarioResolution: base.scenarioResolution || scenarioResolution,
        });

    if (machineReadable && kind === 'broker_report') {
        const sectionTables = await extractBrokerPdfSectionTables(probe.lines || [], userMessage, {
            brokerSubtype: probe.pdfProbe?.brokerSubtype || 'unknown',
            pdfBuffer: file.buffer,
            fileName: file.originalname || file.name || '',
            layoutFingerprint: buildFileLayoutFingerprint(
                file.buffer,
                file.originalname || file.name || ''
            ),
            pool,
            projectId,
        });
        const filterIds = resolveSectionsFromMessage(userMessage);

        if (sectionTables.length === 1 || (filterIds?.length === 1 && sectionTables.length >= 1)) {
            const sec = sectionTables[0];
            const dualExtract =
                kind === 'broker_report'
                    ? comparePdfDualExtract(probe.lines || [], {
                          headers: sec.headers,
                          rows: sec.rows,
                      })
                    : null;
            return finalizePdfTable(ctx, {
                pool,
                file,
                projectId,
                probe,
                scenarioId: pdfScenarioId,
                headers: sec.headers,
                rows: sec.rows,
                sheetName: sec.label,
                confidence: sec.confidence,
                meta: {
                    extractMethod: sec.method,
                    sectionId: sec.id,
                    sectionLabel: sec.label,
                    broker: probe.pdfProbe?.brokerSubtype || null,
                },
                engine: 'pdf_broker_sections',
                dualExtract,
                withScenario,
                baseResponse: {
                    assistantMessage: `Брокер PDF — **${sec.label}**: **${sec.rows?.length || 0}** строк.`,
                },
            });
        }

        if (sectionTables.length >= 2 && shouldUseMultiTableBrokerParse(sectionTables, userMessage)) {
            const snapshots = [];
            for (const sec of sectionTables) {
                const imported = await importTableToSnapshot(pool, {
                    file,
                    projectId,
                    scenarioId: pdfScenarioId,
                    headers: sec.headers,
                    rows: sec.rows,
                    sheetName: sec.label,
                });
                snapshots.push({
                    snapshotId: imported.snapshotId,
                    sheetName: sec.label,
                    label: `${sec.label} · ${imported.rowCount}`,
                    rowCount: imported.rowCount,
                    scenarioId: pdfScenarioId,
                    scenarioName: scenarioDisplayName(pdfScenarioId),
                    parsePreview: imported.parsePreview,
                    sectionId: sec.id,
                });
            }
            const primary = snapshots[0];
            return withScenario({
                sourceKind: 'pdf',
                scenarioId: pdfScenarioId,
                confidence: 0.75,
                snapshotId: primary.snapshotId,
                parsePreview: primary.parsePreview,
                layoutMeta: probe.layoutMeta,
                meta: {
                    extractMethod: 'pdf_broker_sections',
                    sectionCount: snapshots.length,
                    broker: probe.pdfProbe?.brokerSubtype || null,
                },
                engine: 'pdf_broker_sections',
                needsConfirm: true,
                multiTable: true,
                multiSheet: true,
                snapshots,
                sheetNames: snapshots.map((s) => s.sheetName),
                assistantMessage: `Брокер PDF: **${snapshots.length}** таблиц(ы) — ${snapshots.map((s) => s.sheetName).join(', ')}.`,
            });
        }
    }

    if (machineReadable && kind !== 'broker_report') {
        let gridTable = null;
        if (bestPdfScenario) {
            gridTable = await extractWithPdfParseScenario(bestPdfScenario, file.buffer);
        }
        if (!gridTable?.ok || !gridTable?.rows?.length) {
            gridTable = await extractTableGridFromPdf(file.buffer);
        }
        if (isReasonableGridTable(gridTable)) {
            const diagnostics = diagnoseGridExtract(gridTable, gridTable.headers?.length);
            const gridConfidence = diagnostics.confidence ?? gridTable.confidence;
            const dualExtract =
                kind === 'broker_report'
                    ? comparePdfDualExtract(probe.lines || [], gridTable)
                    : null;
            const savedScenarioFound = scenarioResolution?.parseScenario?.status === 'found';
            return finalizePdfTable(ctx, {
                pool,
                file,
                projectId,
                probe,
                scenarioId: pdfScenarioId,
                headers: gridTable.headers,
                rows: gridTable.rows,
                confidence: gridConfidence,
                meta: {
                    extractMethod: gridTable.method,
                    pdfParseScenarioId: bestPdfScenario?.id || null,
                },
                engine: bestPdfScenario ? 'pdfjs_grid_scenario_v3' : 'pdfjs_grid',
                gridDiagnostics: diagnostics,
                dualExtract,
                savedScenarioFound,
                expectedColumnCount: gridTable.headers?.length,
                withScenario,
                baseResponse: {
                    assistantMessage: `PDF (grid): **${gridTable.rows?.length || 0}** строк.`,
                },
            });
        }

        const heuristic = extractPdfTablesFromLines(probe.lines || []);
        if (heuristic.ok && heuristic.rows.length >= 2) {
            const diagnostics = diagnoseGridExtract(heuristic, heuristic.headers?.length);
            return finalizePdfTable(ctx, {
                pool,
                file,
                projectId,
                probe,
                scenarioId: pdfScenarioId,
                headers: heuristic.headers,
                rows: heuristic.rows,
                confidence: heuristic.confidence,
                meta: { extractMethod: heuristic.method },
                engine: 'pdf_table_extract',
                gridDiagnostics: diagnostics,
                withScenario,
                baseResponse: {
                    assistantMessage: `PDF (текст): **${heuristic.rows.length}** строк из таблицы.`,
                },
            });
        }

    const profileHint =
        probe.candidates?.[0]?.profile_hint ||
        (kind === 'broker_report' ? 'broker_pdf' : 'unknown_pdf');
    let rule = getCachedRule(probe.fingerprint, profileHint);
    let ruleType = rule?.rule_schema_version === 2 ? 'parsing_rule_v2' : 'extraction_rule_v1';

    if (!rule && userMessage) {
        const synth = await synthExtractionRuleWithLlm({
            structurePack: probe.structurePack,
            userMessage,
            layoutMeta: probe.layoutMeta,
        });
        if (synth.ok) {
            rule = synth.rule;
            ruleType = synth.ruleType;
            setCachedRule(probe.fingerprint, rule, profileHint);
        }
    }

    if (rule && ruleType === 'extraction_rule_v1') {
        const exec = executeRule(probe, rule);
        const table = exec.tables?.line_items || exec.tables?.[exec.primaryTable];
        if (exec.ok && table?.rows?.length) {
            const imported = await importTableToSnapshot(pool, {
                file,
                projectId,
                scenarioId: rule.meta?.profile_hint || pdfScenarioId,
                headers: table.headers || Object.keys(table.rows[0]),
                rows: table.rows,
            });
            return buildResponse({
                sourceKind: 'pdf',
                scenarioId: rule.meta?.profile_hint || pdfScenarioId,
                confidence: 0.75,
                snapshotId: imported.snapshotId,
                parsePreview: imported.parsePreview,
                layoutMeta: probe.layoutMeta,
                rule,
                engine: 'pdf_rule_engine',
                needsConfirm: true,
                assistantMessage: `PDF по правилу: **${imported.rowCount}** строк. Проверь результат.`,
            });
        }
    }
    }

    // 2) Не машиночитаемый скан — vision-модель (после текстовых сценариев)
    const scanResult = await tryVisionScanFallback(ctx);
    if (scanResult) return scanResult;

    const isScan = isLikelyScanPdf(probe.pdfProbe) || probe.pdfProbe?.isLikelyScan;
    return withScenario({
        sourceKind: 'pdf',
        scenarioId: isScan ? 'document_scan' : 'unknown_pdf',
        confidence: 0.3,
        layoutMeta: probe.layoutMeta,
        structurePack: probe.structurePack,
        needsConfirm: true,
        engine: 'none',
        assistantMessage: isScan
            ? 'Похоже на скан без текстового слоя. Напиши в чате, какие поля вытащить — подключу vision-модель.'
            : scenarioResolution?.parseScenario?.status === 'missing'
              ? 'Сценарий парсинга не найден. Открой редактор колонок или опиши поля — создадим разметку.'
              : 'PDF не распознан автоматически. Опиши, какие поля нужны — соберу правило извлечения.',
    });
}

/**
 * @param {{ pool, file, projectId?, userMessage?, sheetName?, orchestratorAnswers? }} input
 */
async function parseUniversal(input) {
    const { pool, file, projectId, userMessage, sheetName, orchestratorAnswers } = input;
    if (!file?.buffer) {
        return { ok: false, errors: ['file.buffer required'] };
    }

    let probe = await probeDocument(file.buffer, file.originalname || '', {
        sheetName,
        userMessage,
    });
    probe = applyForcedPdfKind(probe, orchestratorAnswers || {});

    if (probe.sourceKind === 'excel') {
        const excelResult = await parseExcelUniversal({ pool, file, sheetName, projectId, probe });
        if (excelResult) return excelResult;

        const rec = probe.layoutMeta?.recommended;
        if ((rec?.confidence ?? 0) < HIGH_CONFIDENCE && userMessage) {
            const synth = await synthExtractionRuleWithLlm({
                structurePack: probe.structurePack,
                userMessage,
                layoutMeta: probe.layoutMeta,
            });
            if (synth.ok) {
                setCachedRule(probe.fingerprint, synth.rule, rec?.profile_hint);
                return buildResponse({
                    sourceKind: 'excel',
                    scenarioId: rec?.profile_hint || 'unknown_table',
                    confidence: rec?.confidence ?? 0.5,
                    layoutMeta: probe.layoutMeta,
                    rule: synth.rule,
                    needsConfirm: true,
                    engine: 'llm_rule_synth',
                    assistantMessage: 'Собрала черновик правила. Подтверди сценарий и запусти парс снова.',
                });
            }
        }
    }

    if (probe.sourceKind === 'pdf') {
        return parsePdfUniversal({ pool, file, projectId, probe, userMessage });
    }

    if (probe.sourceKind === 'image_scan') {
        const scanResult = await parseScanWithVision({
            pool,
            file,
            projectId,
            userMessage,
            sourceKind: 'image_scan',
        });
        if (scanResult) return scanResult;
        return {
            ok: false,
            errors: ['Скан изображения: включи DOCUMENT_SCAN_ENABLED и напиши задачу в чате.'],
            probe,
        };
    }

    return {
        ok: false,
        errors: [`Формат не поддержан универсальным парсером: ${probe.sourceKind}`],
        probe,
    };
}

/**
 * Импорт черновика PDF в snapshot после confirm в UI.
 */
async function confirmPdfDraft(pool, { file, projectId, scenarioId, headers, rows, sheetName = null }) {
    if (!pool) return { ok: false, errors: ['pool required'] };
    if (!file?.buffer) return { ok: false, errors: ['file.buffer required'] };
    if (!Array.isArray(headers) || headers.length < 1) {
        return { ok: false, errors: ['headers required'] };
    }
    if (!Array.isArray(rows) || rows.length < 1) {
        return { ok: false, errors: ['rows required'] };
    }
    const imported = await importTableToSnapshot(pool, {
        file,
        projectId,
        scenarioId: scenarioId || 'pdf_extracted',
        headers,
        rows,
        sheetName,
    });
    return {
        ok: true,
        snapshotId: imported.snapshotId,
        parsePreview: imported.parsePreview,
        rowCount: imported.rowCount,
    };
}

module.exports = {
    parseUniversal,
    parseExcelUniversal,
    parsePdfUniversal,
    buildResponse,
    finalizePdfTable,
    confirmPdfDraft,
    importTableToSnapshot,
    applyForcedPdfKind,
    HIGH_CONFIDENCE,
    PDF_VALIDATION_STRICT,
};
