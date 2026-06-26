const { resolveStructureFromMessage, extractFilePrefixFromText, brokerSectionLabel } = require('./structure_resolve');
const { resolveBrokerSectionFromMessage } = require('./broker_section_resolve');
const { enrichParsePlan } = require('./parse_plan_enrich');
const {
    detectBatchScenario,
    probeFileList,
    fileNameOf,
    isOpifScenario,
} = require('../opif_martin');
const { detectSourceKind } = require('../file_dispatch');

const MERGE_STRATEGY_PATTERNS = {
    one_table: /в\s+одну\s+таб|объедин|смерж|merge|скле|одной\s+таб/i,
    by_group: /по\s+групп|по\s+структур|раздел.*таблиц/i,
    per_file: /по\s+файл|отдельн.*файл|кажд\w+\s+файл/i,
};

function detectMergeStrategyFromMessage(userMessage, groups, orchestratorAnswers = {}) {
    if (orchestratorAnswers.mergeStrategy) return orchestratorAnswers.mergeStrategy;
    if (orchestratorAnswers.pick_merge_strategy) return orchestratorAnswers.pick_merge_strategy;

    const t = String(userMessage || '').toLowerCase();
    if (MERGE_STRATEGY_PATTERNS.one_table.test(t)) return 'one_table';
    if (MERGE_STRATEGY_PATTERNS.by_group.test(t)) return 'by_group';
    if (MERGE_STRATEGY_PATTERNS.per_file.test(t)) return 'per_file';

    const groupCount = groups?.length || 0;
    if (groupCount <= 1) return 'one_table';
    return null;
}
const ALL_SHEETS_PATTERNS = /все\s+лист|кажд\w+\s+лист|multi.?sheet|все\s+вкладк/i;
const PARSE_PATTERNS = /разбер|парс|загруз|обработ|разлож|выгруз/i;

function normalizePrefix(prefix) {
    const p = String(prefix || '').trim();
    if (!p) return null;
    return p.endsWith('_') ? p : `${p}_`;
}

function toFileMetas(files = []) {
    return files.map((f) => ({
        name: fileNameOf(f),
        relativePath: f.relativePath || f.webkitRelativePath || fileNameOf(f),
    }));
}

/**
 * План парса из фразы аудитора + метаданных прикреплённых файлов.
 * Не читает buffer — только имена, probe и текст команды.
 */
function buildParsePlan(userMessage, ctx = {}) {
    const {
        files = [],
        fileMetas = null,
        probe = null,
        layoutMeta = null,
        orchestratorAnswers = {},
        explicitScenarioId = null,
        explicitFilePrefix = null,
        explicitSheetName = null,
        parseAllSheets = null,
    } = ctx;

    const rawMessage = String(userMessage || '').trim();
    const t = rawMessage.toLowerCase();
    const metas = fileMetas?.length ? fileMetas : toFileMetas(files);
    const pseudoFiles = metas.map((m) => ({
        originalname: m.name,
        name: m.name,
        relativePath: m.relativePath || m.name,
    }));

    const fileProbe =
        probe || (metas.length ? probeFileList(metas, rawMessage) : null);
    const structHints = resolveStructureFromMessage(rawMessage, layoutMeta || {});

    const plan = {
        version: 1,
        intent: 'idle',
        scenarioId:
            explicitScenarioId ||
            orchestratorAnswers.scenarioId ||
            structHints.scenarioId ||
            null,
        filePrefix: normalizePrefix(
            explicitFilePrefix ||
                orchestratorAnswers.filePrefix ||
                structHints.filePrefix ||
                extractFilePrefixFromText(rawMessage)
        ),
        fileFilter: null,
        mergeMode: 'single_table',
        mergeStrategy: null,
        groups: null,
        parseAllSheets:
            parseAllSheets === true ||
            parseAllSheets === '1' ||
            ALL_SHEETS_PATTERNS.test(t),
        sheetName:
            explicitSheetName ||
            orchestratorAnswers.sheetName ||
            structHints.sheetName ||
            null,
        profileId: structHints.profileId || orchestratorAnswers.profileId || null,
        ukMode: structHints.ukMode || orchestratorAnswers.ukMode || null,
        brokerSection:
            orchestratorAnswers.brokerSection || structHints.brokerSection || null,
        orchestratorHints: {},
        summary: '',
        confidence: 0.5,
        probe: fileProbe
            ? {
                  fileCount: fileProbe.fileCount,
                  prefixMatches: fileProbe.prefixMatches,
                  suggestedScenario: fileProbe.suggestedScenario,
                  byKind: fileProbe.byKind,
                  groups: fileProbe.groups || null,
              }
            : null,
        groups: fileProbe?.groups || null,
    };

    if (!plan.scenarioId && pseudoFiles.length) {
        plan.scenarioId = detectBatchScenario(pseudoFiles, rawMessage, null);
    }

    if (plan.scenarioId === 'opif_broker' && !plan.brokerSection) {
        plan.brokerSection = resolveBrokerSectionFromMessage(rawMessage).brokerSection;
    }

    if (plan.scenarioId === 'opif_broker' && !plan.filePrefix && fileProbe?.prefix) {
        plan.filePrefix = normalizePrefix(fileProbe.prefix);
    }

    if (plan.filePrefix) {
        plan.fileFilter = { mode: 'prefix', value: plan.filePrefix };
    }

    if (structHints.nameColumn != null) plan.orchestratorHints.nameColumn = structHints.nameColumn;
    if (structHints.quantityColumn != null) {
        plan.orchestratorHints.quantityColumn = structHints.quantityColumn;
    }
    if (structHints.amountColumn != null) plan.orchestratorHints.amountColumn = structHints.amountColumn;

    const groups = ctx.groups || fileProbe?.groups || null;
    plan.groups = groups;

    const mergeStrategy = detectMergeStrategyFromMessage(rawMessage, groups, orchestratorAnswers);
    plan.mergeStrategy = mergeStrategy;

    if (MERGE_STRATEGY_PATTERNS.one_table.test(t) || (metas.length > 1 && isOpifScenario(plan.scenarioId))) {
        plan.mergeMode = 'single_table';
        if (!plan.mergeStrategy) plan.mergeStrategy = 'one_table';
    } else if (mergeStrategy === 'per_file') {
        plan.mergeMode = 'per_file';
    } else if (mergeStrategy === 'by_group') {
        plan.mergeMode = 'by_group';
    } else if (metas.length > 1) {
        plan.mergeMode = groups?.length > 1 ? 'needs_choice' : 'single_table';
        if (!plan.mergeStrategy && groups?.length <= 1) plan.mergeStrategy = 'one_table';
    }

    if (metas.length === 0) {
        plan.intent = 'idle';
    } else if (!rawMessage) {
        plan.intent = metas.length === 1 ? 'parse_sheet' : 'parse_batch';
        plan.confidence = 0.72;
    } else if (isOpifScenario(plan.scenarioId)) {
        plan.intent = 'parse_batch';
        plan.confidence = 0.92;
    } else if (PARSE_PATTERNS.test(t) || plan.profileId || plan.scenarioId) {
        plan.intent = metas.length === 1 ? 'parse_sheet' : 'parse_batch';
        plan.confidence = 0.85;
    } else if (metas.length === 1 && detectSourceKind(metas[0].name) === 'excel') {
        plan.intent = 'parse_sheet';
        plan.confidence = 0.78;
    } else {
        plan.intent = 'parse_batch';
        plan.confidence = 0.65;
    }

    plan.summary = buildPlanSummary(plan, fileProbe);
    return plan;
}

function buildPlanSummary(plan, probe) {
    const parts = [];

    if (plan.scenarioId === 'opif_broker') {
        parts.push(`Брокер OPIF`);
        if (plan.brokerSection) parts.push(brokerSectionLabel(plan.brokerSection));
        if (plan.filePrefix) parts.push(`файлы \`${plan.filePrefix}*\``);
        if (probe?.prefixMatches != null && probe?.fileCount) {
            parts.push(`${probe.prefixMatches}/${probe.fileCount} файлов`);
        }
    } else if (plan.scenarioId === 'opif_depo') {
        parts.push('ДЕПО (PDF)');
        if (probe?.fileCount) parts.push(`${probe.fileCount} PDF`);
    } else if (plan.scenarioId === 'card_90_tsv') {
        parts.push('Выгрузка 1С txt (карточка 90)');
    } else if (plan.scenarioId) {
        parts.push(`сценарий ${plan.scenarioId}`);
    } else if (probe?.fileCount === 1) {
        parts.push('Excel → структура листа → авто-профиль');
    } else if (probe?.fileCount > 1) {
        parts.push('Пакет файлов');
    }

    if (plan.mergeStrategy === 'one_table' && (probe?.fileCount || 0) > 1) {
        parts.push('одна таблица');
    } else if (plan.mergeStrategy === 'by_group' && plan.groups?.length > 1) {
        parts.push(`${plan.groups.length} таблиц по структуре`);
    } else if (plan.mergeStrategy === 'per_file' && (probe?.fileCount || 0) > 1) {
        parts.push('таблица на файл');
    } else if (plan.mergeMode === 'single_table' && (probe?.fileCount || 0) > 1) {
        parts.push('одна таблица');
    }
    if (plan.parseAllSheets) parts.push('все листы');
    if (plan.sheetName) parts.push(`лист «${plan.sheetName}»`);
    if (plan.profileId) parts.push(`профиль ${plan.profileId}`);

    return parts.filter(Boolean).join(' · ') || 'Парс по умолчанию';
}

function applyParsePlanToOrchestratorAnswers(plan, existing = {}) {
    if (!plan) return { ...existing };
    return {
        ...existing,
        ...(plan.scenarioId ? { scenarioId: plan.scenarioId } : {}),
        ...(plan.filePrefix ? { filePrefix: plan.filePrefix } : {}),
        ...(plan.sheetName ? { sheetName: plan.sheetName } : {}),
        ...(plan.profileId ? { profileId: plan.profileId } : {}),
        ...(plan.ukMode ? { ukMode: plan.ukMode } : {}),
        ...(plan.brokerSection ? { brokerSection: plan.brokerSection } : {}),
        ...(plan.mergeStrategy ? { mergeStrategy: plan.mergeStrategy } : {}),
        ...plan.orchestratorHints,
    };
}

async function buildParsePlanAsync(userMessage, ctx = {}) {
    const plan = buildParsePlan(userMessage, ctx);
    const enriched = await enrichParsePlan(plan, userMessage, {
        probe: ctx.probe || plan.probe,
        files: ctx.files || ctx.fileMetas,
    });
    enriched.summary = buildPlanSummary(enriched, ctx.probe || enriched.probe);
    return enriched;
}

module.exports = {
    buildParsePlan,
    buildParsePlanAsync,
    buildPlanSummary,
    applyParsePlanToOrchestratorAnswers,
    detectMergeStrategyFromMessage,
    enrichParsePlan,
    MERGE_STRATEGY_PATTERNS,
    ALL_SHEETS_PATTERNS,
};
