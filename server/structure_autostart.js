const { detectSourceKind } = require('./file_dispatch');
const { isOpifScenario } = require('./opif_martin');
const { loadTargetRows } = require('./compare_target');
const { listSheetNames } = require('./excel_preview');
const { isMetaSheetName } = require('./excel_sheet_meta');
const { orchestrateSheetParse } = require('./sheet_parse_orchestrator');
const { buildValidationRefusalDetail } = require('./structure_refusal');
const { buildReasoningTrace } = require('./reasoning_trace');
const { sanitizeParseApiBody } = require('./client_response_sanitize');

const RETRYABLE_REFUSAL_REASONS = new Set([
    'unknown_structure',
    'лист с пояснением, без данных',
    'low_confidence_structure',
    'ambiguous_structure',
]);

function shouldRetryOtherSheet(parsed, triedSheet) {
    if (parsed?.ok) return false;
    if (isMetaSheetName(triedSheet)) return true;
    if (parsed?.skipped && RETRYABLE_REFUSAL_REASONS.has(parsed.reason)) return true;
    if (parsed?.refused && parsed.reason === 'unknown_structure') return true;
    const sid = parsed?.structure?.structure_id;
    if (sid === 'instruction' || sid === 'workpaper') return true;
    return false;
}

/**
 * Excel autostart → structure orchestrator (fail-closed).
 * scenarioId в стейте — подсказка, не повод уходить в legacy runMartinSession с жирным layoutMeta.
 */
function shouldUseStructureOrchestrator({ fileName, scenarioId, orchestratorAnswers }) {
    if (detectSourceKind(fileName) !== 'excel') return false;
    const sid = scenarioId || orchestratorAnswers?.scenarioId;
    if (isOpifScenario(sid)) return false;
    if (sid === 'from_target') return false;
    if (orchestratorAnswers?.pick_tree_flatten === 'confirm') return false;
    if (String(orchestratorAnswers?.pick_tree_flatten || '').startsWith('scenario:')) return false;
    if (orchestratorAnswers?.pick_scenario) return false;
    return true;
}

async function runExcelStructureAutostart({
    pool,
    file,
    targetFile,
    sheetName,
    projectId,
    savedRules = [],
}) {
    const target = targetFile?.buffer ? loadTargetRows(targetFile.buffer) : null;
    const { sheetNames, defaultSheet } = listSheetNames(file.buffer);
    const tryOrder = [];
    for (const sn of [sheetName, defaultSheet, ...sheetNames]) {
        if (sn && !tryOrder.includes(sn)) tryOrder.push(sn);
    }

    let lastResult = null;
    for (const sn of tryOrder) {
        const parsed = await orchestrateSheetParse({
            pool,
            file,
            sheetName: sn,
            projectId,
            savedRules,
            target,
        });
        if (parsed.ok) return parsed;
        lastResult = parsed;
        if (!shouldRetryOtherSheet(parsed, sn) || tryOrder.length <= 1) break;
        console.log('[structure-autostart] skip sheet', sn, '→ try next, reason:', parsed.reason);
    }
    return lastResult;
}

function formatValidationSummary(validationReport) {
    if (!validationReport) return '';
    if (validationReport.ok) return `\n\nВалидация: **ок** — ${validationReport.summary}`;
    return `\n\nВалидация: **отказ** — ${validationReport.summary}`;
}

function buildReasoningTraceFromParsed(parsed, { parsePlan = null, fileName = null } = {}) {
    return buildReasoningTrace({
        parsePlan,
        structure: parsed.structure,
        profileId: parsed.profileId,
        scenarioId: parsed.scenarioId,
        scenarioName: parsed.scenarioName,
        sheetName: parsed.sheetName,
        fileName,
        triedProfiles: parsed.triedProfiles,
        validationReport: parsed.validationReport,
        rowCount: parsed.rowCount,
        tableMeta: parsed.parsePreview?.tableMeta || null,
        outcome: parsed.ok ? 'success' : 'refused',
        reason: parsed.reason || null,
    });
}

function buildStructureAutostartResponse(parsed, { userMessage = '', parsePlan = null, fileName = null } = {}) {
    const baseMessage =
        parsed.assistantMessage ||
        `Разобрала **${parsed.sheetName}**: **${(parsed.rowCount || 0).toLocaleString('ru-RU')}** строк (${parsed.scenarioName}).`;
    const assistantMessage = baseMessage + formatValidationSummary(parsed.validationReport);

    return sanitizeParseApiBody({
        ok: true,
        scenarioId: parsed.scenarioId,
        scenarioName: parsed.scenarioName,
        sourceKind: 'excel',
        snapshotId: parsed.snapshotId,
        parsePreview: parsed.parsePreview,
        rule: parsed.rule,
        layoutAnalysis: parsed.layoutMeta,
        layoutMeta: parsed.layoutMeta,
        structure: parsed.structure,
        structureId: parsed.structureId,
        validationReport: parsed.validationReport || null,
        warnings: parsed.warnings || [],
        assistantMessage,
        needsUserInput: false,
        needsScenarioChoice: false,
        previewIsTentative: false,
        userMessage,
        staged: false,
        profileId: parsed.profileId,
        reasoningTrace: buildReasoningTraceFromParsed(parsed, { parsePlan, fileName }),
    });
}

function buildStructureRefusalHttpBody(parsed, { parsePlan = null, fileName = null } = {}) {
    const validationDetail = buildValidationRefusalDetail(parsed.validationReport);
    const errorBase = parsed.assistantMessage || parsed.reason || 'unknown_structure';
    return {
        ok: false,
        refused: true,
        error: validationDetail ? `${errorBase}\n${validationDetail}` : errorBase,
        structure: parsed.structure,
        sheetName: parsed.sheetName,
        reason: parsed.reason,
        validationReport: parsed.validationReport || null,
        skipped: [parsed],
        triedProfiles: parsed.triedProfiles,
        reasoningTrace: buildReasoningTraceFromParsed(parsed, { parsePlan, fileName }),
    };
}

module.exports = {
    shouldUseStructureOrchestrator,
    runExcelStructureAutostart,
    buildStructureAutostartResponse,
    buildStructureRefusalHttpBody,
    buildReasoningTraceFromParsed,
};
