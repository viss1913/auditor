const { detectSourceKind } = require('./file_dispatch');
const { analyzeLayout } = require('./analyze_layout');
const { parse1cTsvExport } = require('./parse_1c_tsv');
const { loadTargetRows } = require('./compare_target');
const { pickPreferredSheet } = require('./excel_sheet_meta');
const { listSheetNames } = require('./excel_preview');
const { detectSuggestedScenario } = require('./scenarios/registry');
const {
    getScenarioDef,
    scenarioFromProfileHint,
    blocksTree,
    meetsConfidence,
    scenarioDisplayName,
} = require('./scenarios/catalog');

function mapTextProfileToScenario(profile) {
    if (profile === 'deals_registry_tsv') return 'deals_registry_tsv';
    if (profile === 'card_90_tsv') return 'card_90_tsv';
    return 'card_90_tsv';
}

function resolveExcelScenario(layoutMeta, target, orchestratorAnswers = {}) {
    const detected = detectSuggestedScenario(layoutMeta, target);
    const hint = layoutMeta?.recommended?.profile_hint;
    const confidence = layoutMeta?.recommended?.confidence ?? 0;

    let scenarioId =
        orchestratorAnswers.scenarioId ||
        detected.scenarioId ||
        scenarioFromProfileHint(hint) ||
        'os_01_flat';

    if (orchestratorAnswers.pick_tree_flatten === 'confirm' && layoutMeta?.tree_inference?.profileKey) {
        const fromTree = {
            os_76_card: 'os_76_account_card',
            os_08: 'os_08_osv',
            os_01: 'os_01_hierarchy',
        };
        scenarioId = fromTree[layoutMeta.tree_inference.profileKey] || scenarioId;
    }

    if (String(orchestratorAnswers.pick_tree_flatten || '').startsWith('scenario:')) {
        scenarioId = String(orchestratorAnswers.pick_tree_flatten).slice('scenario:'.length);
    }

    const profileId =
        hint === 'uk_card'
            ? 'uk_card'
            : layoutMeta?.recommended?.layout_type === 'wide_metrics'
              ? 'os_01'
              : layoutMeta?.recommended?.layout_type === 'hierarchy_osv'
                ? 'os_08'
                : 'os_01';

    return {
        scenarioId,
        detected,
        confidence,
        profileId,
        needsUserChoice: detected.needsUserChoice && !orchestratorAnswers.scenarioId,
        autoReady: meetsConfidence(scenarioId, confidence) && !detected.needsUserChoice,
    };
}

function shouldRequireTreeConfirm(layoutMeta, scenarioId, orchestratorAnswers = {}) {
    void layoutMeta;
    void scenarioId;
    void orchestratorAnswers;
    return false;
}

/**
 * Единая точка: файл → сценарий и метаданные.
 * @param {{ buffer: Buffer, fileName: string, sheetName?: string, targetBuffer?: Buffer, orchestratorAnswers?: Object }} input
 */
function resolveUpload(input) {
    const {
        buffer,
        fileName,
        sheetName,
        targetBuffer,
        orchestratorAnswers = {},
    } = input;

    const sourceKind = detectSourceKind(fileName);

    if (sourceKind === 'pdf') {
        return {
            ok: true,
            route: 'opif',
            sourceKind,
            scenarioId: 'opif_depo',
            profileId: 'opif_depo',
            confidence: 1,
            scenarioName: scenarioDisplayName('opif_depo'),
            layoutMeta: {
                sourceKind: 'pdf',
                sourceFileName: fileName,
                recommended: {
                    layout_type: 'fixed_rows',
                    profile_hint: 'opif_depo',
                    description: scenarioDisplayName('opif_depo'),
                    confidence: 1,
                },
            },
            needsTreeConfirm: false,
            autoReady: true,
        };
    }

    if (sourceKind === 'unknown') {
        return {
            ok: false,
            route: 'error',
            sourceKind,
            errors: [`Формат файла не поддержан: ${fileName}`],
        };
    }

    if (sourceKind === 'text_1c') {
        const parsed = parse1cTsvExport(buffer, { fileName });
        if (!parsed.ok) {
            return {
                ok: false,
                route: 'error',
                sourceKind,
                errors: parsed.errors || ['Ошибка разбора текста'],
                textParse: parsed,
            };
        }

        const scenarioId = mapTextProfileToScenario(parsed.profile);
        const warnings = [...(parsed.warnings || [])];
        if (parsed.profile === 'generic_1c_tsv') {
            warnings.push(
                'Формат txt распознан с низкой уверенностью; применена схема card_90. Проверьте шапку файла.'
            );
        }

        return {
            ok: true,
            route: 'text',
            sourceKind,
            scenarioId,
            profileId: 'text_1c',
            confidence: parsed.profile === 'generic_1c_tsv' ? 0.6 : 1,
            scenarioName: scenarioDisplayName(scenarioId),
            textParse: { ...parsed, warnings },
            layoutMeta: {
                sourceKind: 'text_1c',
                sourceFileName: fileName,
                recommended: {
                    layout_type: 'fixed_columns',
                    profile_hint: parsed.profile,
                    description: scenarioDisplayName(scenarioId),
                    confidence: parsed.profile === 'generic_1c_tsv' ? 0.6 : 1,
                },
            },
            needsTreeConfirm: false,
        };
    }

    const { sheetNames } = listSheetNames(buffer);
    const usedSheet = pickPreferredSheet(sheetNames, sheetName);
    const layoutMeta = analyzeLayout(buffer, usedSheet, { fileName });
    layoutMeta.sourceFileName = fileName;
    layoutMeta.sourceKind = 'excel';

    const target = targetBuffer ? loadTargetRows(targetBuffer) : null;
    const excel = resolveExcelScenario(layoutMeta, target, orchestratorAnswers);

    return {
        ok: true,
        route: 'excel',
        sourceKind: 'excel',
        scenarioId: excel.scenarioId,
        profileId: excel.profileId,
        confidence: excel.confidence,
        scenarioName: scenarioDisplayName(excel.scenarioId),
        layoutMeta,
        sheetNames,
        sheetName: usedSheet,
        target,
        detected: excel.detected,
        needsUserChoice: excel.needsUserChoice,
        autoReady: excel.autoReady,
        needsTreeConfirm: shouldRequireTreeConfirm(layoutMeta, excel.scenarioId, orchestratorAnswers),
        candidates: excel.detected.candidates || [],
    };
}

module.exports = {
    resolveUpload,
    resolveExcelScenario,
    shouldRequireTreeConfirm,
    mapTextProfileToScenario,
};
