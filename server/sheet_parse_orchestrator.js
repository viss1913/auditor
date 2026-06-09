/**
 * Оркестратор парсинга одного листа Excel:
 * detect → parse → validate → fallback по реестру профилей.
 */
const { analyzeLayout } = require('./analyze_layout');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { applyOrchestratorToLayoutMeta, buildSessionPlan } = require('./orchestrator/session_plan');
const { resolveUpload } = require('./scenario_router');
const {
    applyScenario,
    detectSuggestedScenario,
    isAccountCard76,
} = require('./scenarios/registry');
const { validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const { runParsePreview, withTempFile } = require('./parse_preview');
const { importFileToSnapshot } = require('./parse_snapshot_import');
const { scenarioDisplayName } = require('./scenarios/catalog');
const { isKsSheetName, tryParseKsSheet, parseKsSheet } = require('./ks_sheet_martin');
const {
    isProcessedOsvSheetName,
    isFlatOsvData,
    tryParseOsvFlatSheet,
} = require('./osv_flat_martin');

const DEFAULT_ORCHESTRATOR_ANSWERS = { pick_tree_flatten: 'confirm' };

function isInstructionSheet(layoutMeta) {
    if (isKsSheetName(layoutMeta?.sheetName)) return false;

    const text = String(layoutMeta?.previewText || layoutMeta?.preview_tsv || '').slice(0, 800);
    const hasInstructionText = /при выгрузке|необходимо чтобы|рассмотрим \d+ сч/i.test(text);
    if (!hasInstructionText) return false;

    const layout = layoutMeta?.recommended?.layout_type;
    if (layout === 'hierarchy_osv') return false;
    if (layoutMeta?.tree_inference?.examples?.length) return false;
    if ((layoutMeta?.tree_inference?.clusterCounts?.contract || 0) > 0) return false;

    return layout === 'fixed_columns';
}

function isPlausibleParse(scenarioId, preview) {
    if (!preview?.ok || !preview.rowCount) return false;
    const headers = (preview.headers || []).map((h) => String(h).toLowerCase());
    const headerText = headers.join(' ');

    if (scenarioId === 'uk_card') {
        return /period|document|operation|debit|credit|сальдо/.test(headerText);
    }
    if (scenarioId === 'os_76_account_card') {
        const sample = (preview.rows || [])[0] || {};
        const cp = String(sample['Контрагент'] || sample.counterparty || '').trim();
        if (!cp) return false;
        return /счёт|контрагент|договор|account|contract/.test(headerText);
    }
    if (scenarioId === 'os_01_hierarchy' || scenarioId === 'os_01_flat') {
        const sample = (preview.rows || [])[0] || {};
        const osVal = String(sample['ОС'] || sample['ос'] || '').trim();
        if (/^\d{2}\.\d{2}\.\d{4}$/.test(osVal)) return false;
        return headers.includes('ос') || headers.includes('группа');
    }
    return true;
}

function scenarioCandidatesForLayout(layoutMeta, primary) {
    const layout = layoutMeta?.recommended?.layout_type;
    const hint = layoutMeta?.recommended?.profile_hint;
    const ordered = [];
    const push = (id) => {
        if (id && !ordered.includes(id)) ordered.push(id);
    };

    push(primary);
    if (layout === 'hierarchy_osv' || layoutMeta?.tree_inference?.profileKey === 'os_76_card') {
        push('os_76_account_card');
    }
    if (layout === 'hierarchy_rows') {
        push('os_76_account_card');
        push('os_01_hierarchy');
        push('os_01_flat');
    }
    if (hint === 'uk_card' || layout === 'fixed_columns') {
        push('uk_card');
    } else {
        push('os_08_osv');
        push('os_01_hierarchy');
        push('os_01_flat');
    }
    return ordered;
}

function resolveSheetScenarioId({ buffer, fileName, layoutMeta, target, orchestratorAnswers }) {
    const routed = resolveUpload({
        buffer,
        fileName,
        sheetName: layoutMeta.sheetName,
        orchestratorAnswers,
    });
    const detected = detectSuggestedScenario(layoutMeta, target);
    return (
        routed.scenarioId ||
        (layoutMeta?.recommended?.profile_hint === 'uk_card' ? 'uk_card' : null) ||
        (orchestratorAnswers?.pick_tree_flatten === 'confirm' &&
        layoutMeta?.tree_inference?.profileKey === 'os_76_card'
            ? 'os_76_account_card'
            : null) ||
        (isAccountCard76(layoutMeta) ? 'os_76_account_card' : null) ||
        detected.scenarioId ||
        'os_01_flat'
    );
}

function previewSheetParse(file, rule, limit = 5000) {
    return withTempFile(file.buffer, file.originalname, (tmpPath) =>
        runParsePreview(tmpPath, rule, limit)
    );
}

async function tryParseSheetWithScenarios({ pool, file, layoutMeta, target, projectId, scenarioIds }) {
    for (const scenarioId of scenarioIds) {
        let meta = applyOrchestratorToLayoutMeta(layoutMeta, { scenarioId });
        const rule = applyScenario(scenarioId, meta, target);
        const validated = validateParsingRuleV2(rule);
        if (!validated.ok) continue;

        const preview = previewSheetParse(file, validated.rule);
        if (!preview.ok || !preview.rowCount || !isPlausibleParse(scenarioId, preview)) continue;

        const imported = await importFileToSnapshot(pool, {
            fileBuffer: file.buffer,
            fileName: file.originalname,
            rule: validated.rule,
            projectId,
            sheetName: layoutMeta.sheetName,
            scenarioId,
        });
        if (!imported.ok) continue;

        return {
            ok: true,
            sheetName: layoutMeta.sheetName,
            scenarioId,
            profileId: 'catalog_scenario',
            scenarioName: scenarioDisplayName(scenarioId),
            snapshotId: imported.snapshotId,
            rowCount: imported.parsePreview?.rowCount ?? preview.rowCount,
            parsePreview: imported.parsePreview,
            warnings: imported.warnings || preview.warnings || [],
            layoutMeta: meta,
            rule: validated.rule,
        };
    }
    return null;
}

function buildSheetContext({ pool, file, sheetName, projectId, savedRules = [], target = null }) {
    const orchestratorAnswers = { ...DEFAULT_ORCHESTRATOR_ANSWERS, sheetName };
    const layoutMeta = analyzeLayout(file.buffer, sheetName, { fileName: file.originalname });
    layoutMeta.sourceFileName = file.originalname;
    layoutMeta.sourceKind = 'excel';
    layoutMeta.sheetName = sheetName;

    const data = readSheetWithMeta(file.buffer, sheetName, { useExcelProbe: true }).data || [];

    return {
        pool,
        file,
        sheetName,
        projectId,
        savedRules,
        target,
        orchestratorAnswers,
        layoutMeta,
        data,
    };
}

function detectKsScore(ctx) {
    if (isKsSheetName(ctx.sheetName)) return 1;
    const parsed = parseKsSheet(ctx.file.buffer, ctx.sheetName);
    return parsed?.rows?.length ? 0.7 : 0;
}

function detectOsvFlatScore(ctx) {
    if (isProcessedOsvSheetName(ctx.sheetName)) return 0.95;
    if (isFlatOsvData(ctx.data)) return 0.85;
    return 0;
}

function detectCatalogScore(ctx) {
    if (isInstructionSheet(ctx.layoutMeta)) return 0;
    const tree = ctx.layoutMeta?.tree_inference;
    if (tree?.examples?.length) return 0.6;
    if (ctx.layoutMeta?.recommended?.layout_type) return 0.5;
    return 0.4;
}

function validateKsResult(result) {
    return Boolean(result?.ok && result.rowCount > 0);
}

function validateOsvFlatResult(result) {
    if (!result?.ok || !result.rowCount) return false;
    const row = result.parsePreview?.rows?.[0] || {};
    return Boolean(String(row['Контрагент'] || row.counterparty || '').trim());
}

function validateCatalogResult(result) {
    return Boolean(result?.ok && result.rowCount > 0);
}

/** @type {Array<{ id: string, name: string, priority: number, detect: Function, parse: Function, validate: Function }>} */
const SHEET_PARSE_PROFILES = [
    {
        id: 'ks_card',
        name: 'Карточка счёта (КС)',
        priority: 100,
        detect: detectKsScore,
        parse: (ctx) =>
            tryParseKsSheet({
                pool: ctx.pool,
                file: ctx.file,
                sheetName: ctx.sheetName,
                projectId: ctx.projectId,
            }),
        validate: validateKsResult,
    },
    {
        id: 'osv_flat_processed',
        name: 'ОСВ плоская (обработанная)',
        priority: 90,
        detect: detectOsvFlatScore,
        parse: (ctx) =>
            tryParseOsvFlatSheet({
                pool: ctx.pool,
                file: ctx.file,
                sheetName: ctx.sheetName,
                projectId: ctx.projectId,
            }),
        validate: validateOsvFlatResult,
    },
    {
        id: 'catalog_scenario',
        name: 'Сценарий из каталога',
        priority: 50,
        detect: detectCatalogScore,
        parse: async (ctx) => {
            const plan = buildSessionPlan(ctx.layoutMeta, ctx.target, null, {
                answers: ctx.orchestratorAnswers,
                savedRules: ctx.savedRules,
            });
            if (plan.needsUserInput && plan.currentQuestion?.id === 'pick_scenario') {
                ctx.orchestratorAnswers.scenarioId =
                    plan.currentQuestion.options?.[0]?.value || plan.sessionState?.scenarioId;
            }
            const primaryScenario = resolveSheetScenarioId({
                buffer: ctx.file.buffer,
                fileName: ctx.file.originalname,
                layoutMeta: ctx.layoutMeta,
                target: ctx.target,
                orchestratorAnswers: ctx.orchestratorAnswers,
            });
            const candidates = scenarioCandidatesForLayout(ctx.layoutMeta, primaryScenario);
            return tryParseSheetWithScenarios({
                pool: ctx.pool,
                file: ctx.file,
                layoutMeta: ctx.layoutMeta,
                target: ctx.target,
                projectId: ctx.projectId,
                scenarioIds: candidates,
            });
        },
        validate: validateCatalogResult,
    },
];

const DETECT_THRESHOLD = 0.4;

function rankProfiles(ctx) {
    return SHEET_PARSE_PROFILES.map((profile) => ({
        profile,
        score: profile.detect(ctx),
    }))
        .filter((entry) => entry.score >= DETECT_THRESHOLD)
        .sort((a, b) => b.score - a.score || b.profile.priority - a.profile.priority);
}

function resolveSheetProfiles(ctx) {
    return rankProfiles(ctx).map((e) => e.profile);
}

async function parseSheetWithProfile(ctx, profile) {
    const result = await profile.parse(ctx);
    if (!result) return null;
    return {
        ...result,
        profileId: profile.id,
        scenarioName: result.scenarioName || profile.name,
    };
}

/**
 * Парс одного листа: перебор профилей по detect-score до первого validate.
 */
async function orchestrateSheetParse({ pool, file, sheetName, projectId, savedRules = [], target = null }) {
    const ctx = buildSheetContext({ pool, file, sheetName, projectId, savedRules, target });

    if (isInstructionSheet(ctx.layoutMeta)) {
        return {
            ok: false,
            sheetName,
            skipped: true,
            reason: 'лист с пояснением, без данных',
        };
    }

    const ranked = rankProfiles(ctx);
    const tried = [];

    for (const { profile, score } of ranked) {
        tried.push({ profileId: profile.id, detectScore: score });
        try {
            const result = await parseSheetWithProfile(ctx, profile);
            if (result && profile.validate(result)) {
                return result;
            }
        } catch (err) {
            tried.push({ profileId: profile.id, error: err.message });
        }
    }

    return {
        ok: false,
        sheetName,
        skipped: true,
        reason: 'нет строк после парса',
        triedProfiles: tried,
    };
}

module.exports = {
    SHEET_PARSE_PROFILES,
    DETECT_THRESHOLD,
    isInstructionSheet,
    isPlausibleParse,
    scenarioCandidatesForLayout,
    resolveSheetScenarioId,
    buildSheetContext,
    rankProfiles,
    resolveSheetProfiles,
    orchestrateSheetParse,
};
