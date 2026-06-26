/**
 * Оркестратор парсинга одного листа Excel:
 * structure classify → profile → parse → validate (fail-closed).
 */
const { analyzeLayout } = require('./analyze_layout');
const { readSheetWithMeta, shouldUseExcelProbe, sheetLoadFromMeta } = require('./excel_sheet_meta');
const { applyOrchestratorToLayoutMeta, buildSessionPlan } = require('./orchestrator/session_plan');
const { resolveUpload } = require('./scenario_router');
const {
    applyScenario,
    detectSuggestedScenario,
    isAccountCard76,
} = require('./scenarios/registry');
const { validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const { runParsePreview, runParseFull, withTempFile } = require('./parse_preview');
const { importFileToSnapshot } = require('./parse_snapshot_import');
const { scenarioDisplayName } = require('./scenarios/catalog');
const { tryParseKsSheet, parseKsSheetFromData } = require('./ks_sheet_martin');
const { detectRevenueScore, tryParseRevenueSheet } = require('./revenue_sheet_martin');
const { detectUkOsv58ProfileScore, tryParseUkOsv58Sheet } = require('./uk_osv_martin');
const { isFlatOsvData, tryParseOsvFlatSheet } = require('./osv_flat_martin');
const {
    classifySheetStructure,
    structureIdToScenarioId,
    STRUCTURE_TO_PROFILE,
    MIN_AUTO_CONFIDENCE,
} = require('./structure_classifier');
const { buildStructureRefusalMessage, buildValidationRefusalDetail } = require('./structure_refusal');
const { structureValidatePreview } = require('./structure_validate');
const { buildParseValidationReport } = require('./parse_validation_report');
const { createParseSnapshotStore } = require('./parse_snapshot_store');
const { detectUkStructure } = require('./layout_fingerprint');
const { buildExcelStructurePack } = require('./universal_parse/structure_pack');
const {
    resolveScenarioWithLlm,
    cacheValidatedScenario,
    classifierFallbackScenario,
} = require('./orchestrator/scenario_router_llm');
const { isLlmRouterEnabled } = require('./martin_flags');
const { shouldSkipLlmRouter } = require('./orchestrator/scenario_router_llm');
const { bootstrapRuleWithLlm, repairRuleWithLlm } = require('./rule_bootstrap_llm');
const { refineRuleForFlatTable } = require('./universal_parse/flat_parse_plan_llm');
const { previewFailsFlatSanity } = require('./flat_parse_sanity');
const {
    buildUkColumnVariants,
    layoutMetaWithUkColumns,
} = require('./uk_layout_probe');

const DEFAULT_ORCHESTRATOR_ANSWERS = { pick_tree_flatten: 'confirm' };
/** Быстрая проба правила при переборе сценариев / LLM-refine (первые N строк листа). */
const QUICK_PARSE_SOURCE_ROWS = 2000;
/** Перебор колонок uk_card без полного прохода по 142k+ строк. */
const UK_VARIANT_PROBE_SOURCE_ROWS = 800;

function runSheetParse(file, rule, sheetLoad, engineOpts = {}) {
    if (sheetLoad) {
        return runParseFull(null, rule, { sheetLoad, ...engineOpts });
    }
    return withTempFile(file.buffer, file.originalname, (tmpPath) =>
        runParseFull(tmpPath, rule, engineOpts)
    );
}

function previewSheetParse(file, rule, limit = 5000, sheetLoad = null, engineOpts = {}) {
    if (sheetLoad) {
        return runParsePreview(null, rule, limit, { sheetLoad, ...engineOpts });
    }
    return withTempFile(file.buffer, file.originalname, (tmpPath) =>
        runParsePreview(tmpPath, rule, limit, engineOpts)
    );
}

function isWorkpaperSheet(layoutMeta) {
    const text = String(layoutMeta?.previewText || layoutMeta?.preview_tsv || '').slice(0, 1200);
    return /процедуры/i.test(text) && /ссылки/i.test(text) && /вывод/i.test(text);
}

function isReferenceSheet(sheetName, layoutMeta) {
    const name = String(sheetName || layoutMeta?.sheetName || '').trim();
    if (/мэппинг|mapping/i.test(name)) return true;
    if (/результат\s+для\s+отч/i.test(name)) return true;
    if (/^мэппинг\s+ручной/i.test(name)) return true;
    return false;
}

function isInstructionSheet(layoutMeta, structure) {
    if (structure?.structure_id === 'workpaper') return true;
    if (structure?.structure_id === 'instruction') return true;
    if (isWorkpaperSheet(layoutMeta)) return true;

    const text = String(layoutMeta?.previewText || layoutMeta?.preview_tsv || '').slice(0, 800);
    const hasInstructionText = /при выгрузке|необходимо чтобы|рассмотрим \d+ сч/i.test(text);
    if (!hasInstructionText) return false;

    const layout = layoutMeta?.recommended?.layout_type;
    if (layout === 'hierarchy_osv') return false;
    if (layoutMeta?.tree_inference?.examples?.length) return false;
    if ((layoutMeta?.tree_inference?.clusterCounts?.contract || 0) > 0) return false;

    return layout === 'fixed_columns';
}

function isPlausibleParse(scenarioId, preview, structureId = null, structure = null) {
    return buildParseValidationReport({
        structure: structure || (structureId ? { structure_id: structureId } : {}),
        scenarioId,
        preview,
    }).ok;
}

function buildValidationReportForResult(ctx, result) {
    return buildParseValidationReport({
        structure: ctx.structure,
        scenarioId: result.scenarioId,
        profileId: result.profileId,
        preview: result.parsePreview,
        target: ctx.target,
    });
}

async function acceptParseResultIfValid(ctx, result) {
    const report = buildValidationReportForResult(ctx, result);
    if (report.ok) {
        return { accepted: true, result: { ...result, validationReport: report }, report };
    }
    if (result.snapshotId && ctx.pool) {
        const store = createParseSnapshotStore(ctx.pool);
        await store.deleteSnapshot(result.snapshotId);
    }
    return { accepted: false, result, report };
}

function scenarioCandidatesForStructure(structure, layoutMeta, primary) {
    const ordered = [];
    const push = (id) => {
        if (id && !ordered.includes(id)) ordered.push(id);
    };

    push(primary);
    const sid = structure?.structure_id;

    if (sid === 'tree_account_76') {
        push('os_76_account_card');
        return ordered;
    }
    if (sid === 'tree_os_08') {
        push('os_08_osv');
        return ordered;
    }
    if (sid === 'hierarchy_os_01') {
        push('os_01_hierarchy');
        push('os_01_flat');
        return ordered;
    }
    if (sid === 'uk_journal_58') {
        push('uk_card');
        push('ks_card_composite_raw');
        return ordered;
    }
    if (sid === 'uk_osv_58') {
        push('uk_osv_58');
        return ordered;
    }
    if (sid === 'journal_1c') {
        return ordered;
    }

    const layout = layoutMeta?.recommended?.layout_type;
    const hint = layoutMeta?.recommended?.profile_hint;
    push(primary);
    if (layout === 'hierarchy_osv' || layoutMeta?.tree_inference?.profileKey === 'os_76_card') {
        push('os_76_account_card');
    }
    if (layout === 'hierarchy_rows') {
        push('os_76_account_card');
        push('os_01_hierarchy');
    }
    if (hint === 'uk_card' || layout === 'fixed_columns') {
        push('uk_card');
    } else if (sid !== 'revenue_osv_90') {
        push('os_08_osv');
        push('os_01_hierarchy');
    }
    return ordered;
}

function scenarioCandidatesForLayout(layoutMeta, primary) {
    return scenarioCandidatesForStructure(null, layoutMeta, primary);
}

async function resolveSheetScenarioId({ buffer, fileName, layoutMeta, target, orchestratorAnswers, structure }) {
    const fromStructure = structureIdToScenarioId(structure);
    if (fromStructure) return fromStructure;

    const routed = await resolveUpload({
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
        null
    );
}

async function tryUkCardColumnVariants({
    pool,
    file,
    layoutMeta,
    target,
    projectId,
    structure,
    sheetCtx,
    userMessage,
}) {
    const variants = buildUkColumnVariants(layoutMeta.uk_probe);
    const previewLimit = 120;
    const sheetLoad = sheetCtx?.sheetLoad || null;

    for (const cols of variants) {
        const meta = layoutMetaWithUkColumns(layoutMeta, cols);
        const rule = applyScenario('uk_card', meta, target);
        const validated = validateParsingRuleV2(rule);
        if (!validated.ok) continue;

        const preview = previewSheetParse(file, validated.rule, previewLimit, sheetLoad, {
            maxSourceRows: UK_VARIANT_PROBE_SOURCE_ROWS,
        });
        if (
            !preview.ok ||
            !preview.rowCount ||
            previewFailsFlatSanity('uk_card', preview, meta) ||
            !isPlausibleParse('uk_card', preview, structure?.structure_id, structure)
        ) {
            continue;
        }

        const fullParse = runSheetParse(file, validated.rule, sheetLoad);
        if (!fullParse.ok || !fullParse.rowCount) continue;

        const imported = await importFileToSnapshot(pool, {
            fileBuffer: file.buffer,
            fileName: file.originalname,
            rule: validated.rule,
            projectId,
            sheetName: meta.sheetName,
            scenarioId: 'uk_card',
            parseResult: fullParse,
            sheetLoad,
        });
        if (!imported.ok) continue;

        return {
            ok: true,
            sheetName: meta.sheetName,
            scenarioId: 'uk_card',
            profileId: 'uk_card',
            scenarioName: scenarioDisplayName('uk_card'),
            snapshotId: imported.snapshotId,
            rowCount: imported.parsePreview?.rowCount ?? preview.rowCount,
            parsePreview: imported.parsePreview,
            warnings: imported.warnings || preview.warnings || [],
            layoutMeta: meta,
            rule: validated.rule,
            structureId: structure?.structure_id,
            flatParseSource: `uk_columns_${cols.variant || 'variant'}`,
            reasoningTrace: sheetCtx?.reasoningTrace,
        };
    }
    return null;
}

async function tryParseSheetWithScenarios({
    pool,
    file,
    layoutMeta,
    target,
    projectId,
    scenarioIds,
    structure,
    ctx = null,
    userMessage = '',
}) {
    for (const scenarioId of scenarioIds) {
        if (!scenarioId) continue;

        if (scenarioId === 'uk_card' && structure?.structure_id === 'uk_journal_58') {
            const ukDirect = await tryUkCardColumnVariants({
                pool,
                file,
                layoutMeta,
                target,
                projectId,
                structure,
                sheetCtx: ctx,
                userMessage,
            });
            if (ukDirect) return ukDirect;
        }

        let meta = applyOrchestratorToLayoutMeta(layoutMeta, { scenarioId });
        let rule = applyScenario(scenarioId, meta, target);
        let validated = validateParsingRuleV2(rule);
        if (!validated.ok) continue;

        const sheetCtx =
            ctx ||
            ({
                layoutMeta: meta,
                data: [],
                structure,
                structurePack: null,
                file,
            });
        const sheetLoad = sheetCtx.sheetLoad || null;
        const quickOpts = { maxSourceRows: QUICK_PARSE_SOURCE_ROWS };

        let preview = previewSheetParse(file, validated.rule, 5000, sheetLoad, quickOpts);

        const skipFlatLlm =
            scenarioId === 'uk_card' && structure?.structure_id === 'uk_journal_58';

        const refined = skipFlatLlm
            ? { ok: true, rule: validated.rule, source: 'uk_card_probe', skipped: true }
            : await refineRuleForFlatTable({
                  ctx: sheetCtx,
                  scenarioId,
                  baseRule: validated.rule,
                  userMessage,
                  preview: preview.ok ? preview : null,
              });
        if (refined.ok && refined.rule) {
            rule = refined.rule;
            validated = validateParsingRuleV2(rule);
            if (!validated.ok) continue;
            preview = previewSheetParse(file, validated.rule, 5000, sheetLoad, quickOpts);
        }

        if (
            !preview.ok ||
            !preview.rowCount ||
            !isPlausibleParse(scenarioId, preview, structure?.structure_id, structure)
        ) {
            if (
                refined.source === 'base' &&
                previewFailsFlatSanity(scenarioId, preview, meta) &&
                !(scenarioId === 'uk_card' && structure?.structure_id === 'uk_journal_58')
            ) {
                const forced = await refineRuleForFlatTable({
                    ctx: sheetCtx,
                    scenarioId,
                    baseRule: applyScenario(scenarioId, meta, target),
                    userMessage: userMessage || 'Исправь правило для плоской таблицы',
                    force: true,
                });
                if (forced.ok && forced.rule) {
                    rule = forced.rule;
                    validated = validateParsingRuleV2(rule);
                    if (validated.ok) {
                        preview = previewSheetParse(file, validated.rule, 5000, sheetLoad, quickOpts);
                    }
                }
            }
            if (
                !preview.ok ||
                !preview.rowCount ||
                !isPlausibleParse(scenarioId, preview, structure?.structure_id, structure)
            ) {
                continue;
            }
        }

        const fullParse = runSheetParse(file, validated.rule, sheetLoad);
        if (!fullParse.ok || !fullParse.rowCount) continue;

        const imported = await importFileToSnapshot(pool, {
            fileBuffer: file.buffer,
            fileName: file.originalname,
            rule: validated.rule,
            projectId,
            sheetName: layoutMeta.sheetName,
            scenarioId,
            parseResult: fullParse,
            sheetLoad,
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
            structureId: structure?.structure_id,
            flatParseSource: refined.source,
        };
    }
    return null;
}

function buildSheetContext({ pool, file, sheetName, projectId, savedRules = [], target = null }) {
    const orchestratorAnswers = { ...DEFAULT_ORCHESTRATOR_ANSWERS, sheetName };
    const useProbe = shouldUseExcelProbe(file.buffer);
    const loaded = readSheetWithMeta(file.buffer, sheetName, {
        useExcelProbe: useProbe,
        fileName: file.originalname,
    });
    const layoutMeta = analyzeLayout(file.buffer, sheetName, {
        fileName: file.originalname,
        useExcelProbe: useProbe,
        loaded,
    });
    layoutMeta.sourceFileName = file.originalname;
    layoutMeta.sourceKind = 'excel';
    layoutMeta.sheetName = sheetName;
    const data = loaded.data || [];
    const structure = classifySheetStructure(data, {
        hasOutline: loaded.hasOutline,
        rowOutlineLevels: loaded.rowOutlineLevels,
        mergedRanges: loaded.mergedRanges,
        layoutMeta,
    });
    layoutMeta.structure = structure;
    const structurePack = buildExcelStructurePack({
        layoutMeta,
        data,
        structure,
        sheetMeta: loaded,
        file,
    });

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
        structure,
        sheetMeta: loaded,
        sheetLoad: sheetLoadFromMeta(loaded),
        structurePack,
    };
}

function profileIdForStructure(structure) {
    if (!structure?.autoParse) return null;
    return STRUCTURE_TO_PROFILE[structure.structure_id] || null;
}

function detectScoreForProfile(ctx, profileId) {
    const s = ctx.structure;
    if (!s || !profileId) return 0;

    if (s.structure_id === 'instruction' || s.structure_id === 'workpaper') return 0;
    if (s.structure_id === 'unknown') return 0;
    if (!s.autoParse) return 0;

    const mapped = profileIdForStructure(s);
    if (mapped !== profileId) return 0;

    let score = s.confidence;
    if (profileId === 'ks_card') {
        const parsed = parseKsSheetFromData(ctx.data);
        if (parsed?.rows?.length) score = Math.max(score, 0.92);
    }
    if (profileId === 'revenue_period') {
        score = detectRevenueScore(ctx);
    }
    if (profileId === 'uk_osv_58') {
        score = detectUkOsv58ProfileScore(ctx);
    }
    if (profileId === 'osv_flat_processed' && isFlatOsvData(ctx.data)) {
        score = Math.max(score, 0.85);
    }
    if (profileId === 'catalog_scenario') {
        if (['tree_account_76', 'tree_os_08', 'hierarchy_os_01', 'wide_years'].includes(s.structure_id)) {
            score = Math.max(score, 0.88);
        } else {
            return 0;
        }
    }
    return score;
}

function detectUkCardScore(ctx) {
    const mapped = detectScoreForProfile(ctx, 'uk_card');
    if (mapped > 0) return mapped;
    if (ctx.layoutMeta?.recommended?.profile_hint === 'uk_card') {
        return Math.max(0.88, ctx.structure?.confidence || 0);
    }
    return 0;
}

function detectKsScore(ctx) {
    return detectScoreForProfile(ctx, 'ks_card');
}

function detectUkOsvProfileScore(ctx) {
    return detectScoreForProfile(ctx, 'uk_osv_58');
}

function detectRevenueProfileScore(ctx) {
    return detectScoreForProfile(ctx, 'revenue_period');
}

function detectOsvFlatScore(ctx) {
    return detectScoreForProfile(ctx, 'osv_flat_processed');
}

function detectCatalogScore(ctx) {
    return detectScoreForProfile(ctx, 'catalog_scenario');
}

function validateKsResult(result, ctx) {
    if (!result?.ok || !result.rowCount) return false;
    return structureValidatePreview(
        ctx.structure?.structure_id,
        result.scenarioId,
        result.parsePreview,
        ctx.structure
    );
}

function validateOsvFlatResult(result) {
    if (!result?.ok || !result.rowCount) return false;
    const row = result.parsePreview?.rows?.[0] || {};
    return Boolean(String(row['Контрагент'] || row.counterparty || '').trim());
}

function validateCatalogResult(result, ctx) {
    if (!result?.ok || !result.rowCount) return false;
    return structureValidatePreview(
        ctx.structure?.structure_id,
        result.scenarioId,
        result.parsePreview,
        ctx.structure
    );
}

/** @type {Array<{ id: string, name: string, priority: number, detect: Function, parse: Function, validate: Function }>} */
const SHEET_PARSE_PROFILES = [
    {
        id: 'uk_card',
        name: 'Карточка УК 58.01 (БУ + Кол.)',
        priority: 102,
        detect: detectUkCardScore,
        parse: async (ctx) =>
            tryParseSheetWithScenarios({
                pool: ctx.pool,
                file: ctx.file,
                layoutMeta: ctx.layoutMeta,
                target: ctx.target,
                projectId: ctx.projectId,
                scenarioIds: ['uk_card'],
                structure: ctx.structure,
                ctx,
                userMessage: ctx.userMessage || '',
            }),
        validate: validateCatalogResult,
    },
    {
        id: 'ks_card',
        name: 'Карточка счёта (журнал 1С)',
        priority: 100,
        detect: detectKsScore,
        parse: (ctx) =>
            tryParseKsSheet({
                pool: ctx.pool,
                file: ctx.file,
                sheetName: ctx.sheetName,
                projectId: ctx.projectId,
                data: ctx.data,
            }),
        validate: validateKsResult,
    },
    {
        id: 'uk_osv_58',
        name: 'ОСВ УК 58.01 (дерево)',
        priority: 99,
        detect: detectUkOsvProfileScore,
        parse: (ctx) =>
            tryParseUkOsv58Sheet({
                pool: ctx.pool,
                file: ctx.file,
                sheetName: ctx.sheetName,
                projectId: ctx.projectId,
                data: ctx.data,
            }),
        validate: validateKsResult,
    },
    {
        id: 'revenue_period',
        name: 'Выручка (счёт 90)',
        priority: 98,
        detect: detectRevenueProfileScore,
        parse: (ctx) =>
            tryParseRevenueSheet({
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
                return null;
            }
            const primaryScenario =
                structureIdToScenarioId(ctx.structure) ||
                (await resolveSheetScenarioId({
                    buffer: ctx.file.buffer,
                    fileName: ctx.file.originalname,
                    layoutMeta: ctx.layoutMeta,
                    target: ctx.target,
                    orchestratorAnswers: ctx.orchestratorAnswers,
                    structure: ctx.structure,
                }));
            if (!primaryScenario) return null;
            const candidates = scenarioCandidatesForStructure(
                ctx.structure,
                ctx.layoutMeta,
                primaryScenario
            );
            return tryParseSheetWithScenarios({
                pool: ctx.pool,
                file: ctx.file,
                layoutMeta: ctx.layoutMeta,
                target: ctx.target,
                projectId: ctx.projectId,
                scenarioIds: candidates,
                structure: ctx.structure,
                ctx,
                userMessage: ctx.userMessage || '',
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

function buildRefusalResult(ctx, reason) {
    return {
        ok: false,
        sheetName: ctx.sheetName,
        skipped: true,
        refused: true,
        reason: reason || 'unknown_structure',
        structure: ctx.structure,
        assistantMessage: buildStructureRefusalMessage({
            sheetName: ctx.sheetName,
            structure: ctx.structure,
            reason,
        }),
    };
}

async function tryParseWithSynthRule(ctx, { baseRule = null, failedChecks = null, userMessage = '' } = {}) {
    const boot = await bootstrapRuleWithLlm({
        layoutMeta: ctx.layoutMeta,
        structurePack: ctx.structurePack,
        userMessage: userMessage || 'Собери правило парсинга для этого листа',
        baseRule,
        failedChecks,
        validationFailed: Boolean(failedChecks?.length),
    });
    if (!boot.ok || !boot.rule) return null;

    const preview = previewSheetParse(ctx.file, boot.rule, 5000, ctx.sheetLoad, {
        maxSourceRows: QUICK_PARSE_SOURCE_ROWS,
    });
    if (!preview.ok || !preview.rowCount) return null;

    const report = buildParseValidationReport({
        structure: ctx.structure,
        scenarioId: 'custom_rule',
        preview,
        target: ctx.target,
    });
    if (!report.ok) return { boot, preview, report, accepted: false };

    const fullParse = runSheetParse(ctx.file, boot.rule, ctx.sheetLoad);
    if (!fullParse.ok || !fullParse.rowCount) return { boot, preview, report, accepted: false };

    const imported = await importFileToSnapshot(ctx.pool, {
        fileBuffer: ctx.file.buffer,
        fileName: ctx.file.originalname,
        rule: boot.rule,
        projectId: ctx.projectId,
        sheetName: ctx.layoutMeta.sheetName,
        scenarioId: 'custom_rule',
        parseResult: fullParse,
        sheetLoad: ctx.sheetLoad,
    });
    if (!imported.ok) return { boot, preview, report, accepted: false };

    return {
        ok: true,
        sheetName: ctx.layoutMeta.sheetName,
        scenarioId: 'custom_rule',
        profileId: 'llm_synth',
        scenarioName: 'Synth правило (LLM)',
        snapshotId: imported.snapshotId,
        rowCount: imported.parsePreview?.rowCount ?? preview.rowCount,
        parsePreview: imported.parsePreview,
        warnings: imported.warnings || preview.warnings || [],
        layoutMeta: ctx.layoutMeta,
        rule: boot.rule,
        validationReport: report,
        accepted: true,
        source: boot.source,
    };
}

async function tryParseWithRouterScenario(ctx, routerResult) {
    const scenarioId = routerResult?.scenarioId;
    if (!scenarioId || scenarioId === 'custom_rule') return null;

    const candidates = [
        scenarioId,
        ...scenarioCandidatesForStructure(ctx.structure, ctx.layoutMeta, scenarioId),
    ];
    const result = await tryParseSheetWithScenarios({
        pool: ctx.pool,
        file: ctx.file,
        layoutMeta: ctx.layoutMeta,
        target: ctx.target,
        projectId: ctx.projectId,
        scenarioIds: [...new Set(candidates)],
        structure: ctx.structure,
        ctx,
        userMessage: ctx.userMessage || '',
    });
    if (!result) return null;

    const { accepted, result: finalResult, report } = await acceptParseResultIfValid(ctx, {
        ...result,
        profileId: 'llm_router',
    });
    return { accepted, result: finalResult, report };
}

function applyRouterToStructure(ctx, routerResult) {
    if (!routerResult?.scenarioId || routerResult.scenarioId === 'custom_rule') return;
    ctx.structure = {
        ...ctx.structure,
        routerScenarioId: routerResult.scenarioId,
        ambiguous: false,
        autoParse: true,
        confidence: Math.max(ctx.structure.confidence || 0, routerResult.confidence || 0),
    };
}

async function orchestrateSheetParse({ pool, file, sheetName, projectId, savedRules = [], target = null, userMessage = '' }) {
    const ctx = buildSheetContext({ pool, file, sheetName, projectId, savedRules, target });
    if (userMessage) {
        ctx.structurePack.userMessage = userMessage;
        ctx.userMessage = userMessage;
    }

    if (isInstructionSheet(ctx.layoutMeta, ctx.structure)) {
        return {
            ok: false,
            sheetName,
            skipped: true,
            reason: 'лист с пояснением, без данных',
        };
    }

    if (isReferenceSheet(sheetName, ctx.layoutMeta)) {
        return {
            ok: false,
            sheetName,
            skipped: true,
            reason: 'лист-эталон (мэппинг/результат), не исходные данные',
        };
    }

    if (ctx.structure.structure_id === 'unknown') {
        return buildRefusalResult(ctx, 'unknown_structure');
    }

    let routerResult = null;
    if (isLlmRouterEnabled()) {
        const skipLlm = shouldSkipLlmRouter(ctx.structure, ctx.structurePack);
        routerResult = await resolveScenarioWithLlm(ctx.structurePack, { userMessage, skipLlm });
        ctx.routerResult = routerResult;
        ctx.reasoningTrace = {
            router: routerResult,
            ontology: ctx.structurePack.ontology,
        };

        if (ctx.structure.ambiguous || !ctx.structure.autoParse) {
            if (routerResult.scenarioId === 'custom_rule') {
                ctx.structure = { ...ctx.structure, ambiguous: false, autoParse: true };
            } else {
                applyRouterToStructure(ctx, routerResult);
            }
        }

        if (routerResult.scenarioId && routerResult.scenarioId !== 'custom_rule') {
            const routed = await tryParseWithRouterScenario(ctx, routerResult);
            if (routed?.accepted) {
                cacheValidatedScenario(ctx.structurePack.fingerprint, routerResult);
                return {
                    ...routed.result,
                    structureId: ctx.structure.structure_id,
                    structure: ctx.structure,
                    reasoningTrace: ctx.reasoningTrace,
                };
            }
            if (routed?.report) ctx.lastValidationReport = routed.report;
        }

        if (routerResult.scenarioId === 'custom_rule' || routerResult.fallback === 'bootstrap') {
            const synth = await tryParseWithSynthRule(ctx, { userMessage });
            if (synth?.accepted) {
                return {
                    ...synth,
                    structureId: ctx.structure.structure_id,
                    structure: ctx.structure,
                    reasoningTrace: ctx.reasoningTrace,
                };
            }
        }
    } else if (ctx.structure.ambiguous) {
        const uk = detectUkStructure(ctx.data || []);
        const ukAlt = (ctx.structure.alternatives || []).find((a) => a.structure_id === 'uk_journal_58');
        const ukWins =
            (uk.structureMatch || uk.bu58 >= 2) &&
            ukAlt?.confidence >= 0.85 &&
            ctx.structure.structure_id === 'journal_1c';
        if (ukWins) {
            ctx.structure = {
                ...ctx.structure,
                structure_id: 'uk_journal_58',
                confidence: Math.max(ctx.structure.confidence, ukAlt.confidence, 0.92),
                fingerprint_reason: `journal+uk bu58=${uk.bu58} dates=${uk.dateRows}`,
                ambiguous: false,
                autoParse: true,
                profileId: 'uk_card',
            };
        } else {
            return buildRefusalResult(ctx, 'ambiguous_structure');
        }
    }

    if (!ctx.structure.autoParse) {
        return buildRefusalResult(ctx, 'low_confidence_structure');
    }

    const ranked = rankProfiles(ctx);
    const tried = [];

    if (!ranked.length) {
        return buildRefusalResult(ctx, 'no_matching_profile');
    }

    let lastValidationReport = null;
    let lastFailedResult = null;

    for (const { profile, score } of ranked) {
        tried.push({ profileId: profile.id, detectScore: score, structureId: ctx.structure.structure_id });
        try {
            const result = await parseSheetWithProfile(ctx, profile);
            if (!result || !profile.validate(result, ctx)) continue;

            const { accepted, result: finalResult, report } = await acceptParseResultIfValid(ctx, result);
            lastValidationReport = report;
            if (accepted) {
                if (ctx.routerResult) {
                    cacheValidatedScenario(ctx.structurePack.fingerprint, ctx.routerResult);
                }
                return {
                    ...finalResult,
                    structureId: ctx.structure.structure_id,
                    structure: ctx.structure,
                    reasoningTrace: ctx.reasoningTrace,
                };
            }
            lastFailedResult = finalResult || result;
        } catch (err) {
            tried.push({ profileId: profile.id, error: err.message });
        }
    }

    const refusal = buildRefusalResult(ctx, 'parse_validation_failed');
    if (lastValidationReport) {
        refusal.validationReport = lastValidationReport;
        refusal.assistantMessage = [
            refusal.assistantMessage,
            buildValidationRefusalDetail(lastValidationReport),
        ]
            .filter(Boolean)
            .join('\n');
    }

    if (isLlmRouterEnabled() && lastValidationReport && !lastValidationReport.ok) {
        const baseRule = lastFailedResult?.rule || null;
        const repair = await repairRuleWithLlm({
            baseRule,
            layoutMeta: ctx.layoutMeta,
            structurePack: ctx.structurePack,
            failedChecks: lastValidationReport.checks || [],
        });
        if (repair.ok && repair.rule) {
            const preview = previewSheetParse(ctx.file, repair.rule, 5000, ctx.sheetLoad, {
                maxSourceRows: QUICK_PARSE_SOURCE_ROWS,
            });
            const report = buildParseValidationReport({
                structure: ctx.structure,
                scenarioId: routerResult?.scenarioId || classifierFallbackScenario(ctx.structurePack),
                preview,
                target: ctx.target,
            });
            if (report.ok && preview.ok && preview.rowCount) {
                const fullParse = runSheetParse(ctx.file, repair.rule, ctx.sheetLoad);
                if (fullParse.ok && fullParse.rowCount) {
                    const imported = await importFileToSnapshot(pool, {
                        fileBuffer: file.buffer,
                        fileName: file.originalname,
                        rule: repair.rule,
                        projectId,
                        sheetName: ctx.layoutMeta.sheetName,
                        scenarioId: routerResult?.scenarioId || 'custom_rule',
                        parseResult: fullParse,
                        sheetLoad: ctx.sheetLoad,
                    });
                    if (imported.ok) {
                        if (routerResult) cacheValidatedScenario(ctx.structurePack.fingerprint, routerResult);
                        return {
                            ok: true,
                            sheetName,
                            scenarioId: routerResult?.scenarioId || 'custom_rule',
                            profileId: 'llm_repair',
                            scenarioName: scenarioDisplayName(routerResult?.scenarioId || 'custom_rule'),
                            snapshotId: imported.snapshotId,
                            rowCount: imported.parsePreview?.rowCount ?? preview.rowCount,
                            parsePreview: imported.parsePreview,
                            structureId: ctx.structure.structure_id,
                            structure: ctx.structure,
                            validationReport: report,
                            reasoningTrace: ctx.reasoningTrace,
                            repaired: true,
                        };
                    }
                }
            }
        }
        const synth = await tryParseWithSynthRule(ctx, {
            userMessage,
            failedChecks: lastValidationReport.checks,
        });
        if (synth?.accepted) {
            return {
                ...synth,
                structureId: ctx.structure.structure_id,
                structure: ctx.structure,
                reasoningTrace: ctx.reasoningTrace,
            };
        }
    }

    return {
        ...refusal,
        triedProfiles: tried,
        reasoningTrace: ctx.reasoningTrace,
    };
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

function resolveSheetProfiles(ctx) {
    return rankProfiles(ctx).map((e) => e.profile);
}

module.exports = {
    SHEET_PARSE_PROFILES,
    DETECT_THRESHOLD,
    MIN_AUTO_CONFIDENCE,
    isInstructionSheet,
    isReferenceSheet,
    isPlausibleParse,
    buildValidationReportForResult,
    acceptParseResultIfValid,
    scenarioCandidatesForLayout,
    scenarioCandidatesForStructure,
    resolveSheetScenarioId,
    buildSheetContext,
    buildExcelStructurePack: require('./universal_parse/structure_pack').buildExcelStructurePack,
    rankProfiles,
    resolveSheetProfiles,
    orchestrateSheetParse,
    buildRefusalResult,
};
