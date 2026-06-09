/**
 * Каталог сценариев парсинга: layout, движок, порог уверенности, дерево.
 */
const SCENARIO_CATALOG = {
    uk_card: {
        id: 'uk_card',
        name: 'Карточка УК 58.01',
        layoutType: 'fixed_columns',
        engine: 'parse_engine',
        ruleExample: 'uk_card.json',
        needsTree: 'no',
        minConfidence: 0.88,
        profileHints: ['uk_card'],
    },
    os_76_account_card: {
        id: 'os_76_account_card',
        name: 'Карточка счёта 76',
        layoutType: 'hierarchy_osv',
        engine: 'tree_walker',
        ruleExample: 'os_hierarchy_08.json',
        needsTree: 'yes',
        minConfidence: 0.9,
        profileHints: ['os_account_card_76'],
    },
    os_08_osv: {
        id: 'os_08_osv',
        name: 'ОСВ 08',
        layoutType: 'hierarchy_osv',
        engine: 'tree_walker',
        ruleExample: 'os_hierarchy_08.json',
        needsTree: 'yes',
        minConfidence: 0.85,
        profileHints: ['os_osv_08'],
    },
    os_01_hierarchy: {
        id: 'os_01_hierarchy',
        name: 'Ведомость ОС с деревом',
        layoutType: 'hierarchy_rows',
        engine: 'tree_walker',
        ruleExample: 'os_hierarchy_01.json',
        needsTree: 'ask',
        minConfidence: 0.7,
        profileHints: ['os_depreciation_01'],
    },
    os_01_flat: {
        id: 'os_01_flat',
        name: 'Ведомость ОС плоская',
        layoutType: 'hierarchy_rows',
        engine: 'tree_walker',
        ruleExample: 'os_hierarchy_01.json',
        needsTree: 'no',
        minConfidence: 0.7,
        profileHints: [],
    },
    os_01_cost_only: {
        id: 'os_01_cost_only',
        name: 'ОС — только стоимость',
        layoutType: 'hierarchy_rows',
        engine: 'tree_walker',
        ruleExample: 'os_hierarchy_01_cost_only.json',
        needsTree: 'ask',
        minConfidence: 0.7,
        profileHints: [],
    },
    wide_metrics: {
        id: 'wide_metrics',
        name: 'ОС — годы в колонках',
        layoutType: 'wide_metrics',
        engine: 'parse_engine',
        ruleExample: 'os_wide_years.json',
        needsTree: 'no',
        minConfidence: 0.85,
        profileHints: ['os_wide_years'],
    },
    from_target: {
        id: 'from_target',
        name: 'Как в эталоне',
        layoutType: null,
        engine: 'target_rule_infer',
        ruleExample: 'os_hierarchy_01.json',
        needsTree: 'no',
        minConfidence: 1,
        profileHints: [],
    },
    card_90_tsv: {
        id: 'card_90_tsv',
        name: 'Карточка 90 (txt)',
        layoutType: 'fixed_columns',
        engine: 'parse_1c_tsv',
        ruleExample: null,
        needsTree: 'no',
        minConfidence: 1,
        profileHints: ['card_90_tsv'],
    },
    deals_registry_tsv: {
        id: 'deals_registry_tsv',
        name: 'Реестр сделок (txt)',
        layoutType: 'fixed_columns',
        engine: 'parse_1c_tsv',
        ruleExample: null,
        needsTree: 'no',
        minConfidence: 1,
        profileHints: ['deals_registry_tsv'],
    },
    opif_depo: {
        id: 'opif_depo',
        name: 'ОПИФ — выписки ДЕПО (PDF)',
        layoutType: 'fixed_rows',
        engine: 'parse_depo',
        ruleExample: null,
        needsTree: 'no',
        minConfidence: 1,
        profileHints: ['opif_depo'],
    },
    opif_broker: {
        id: 'opif_broker',
        name: 'ОПИФ — отчёт брокера (1.2)',
        layoutType: 'fixed_rows',
        engine: 'parse_broker',
        ruleExample: null,
        needsTree: 'no',
        minConfidence: 1,
        profileHints: ['opif_broker'],
    },
};

const HINT_TO_SCENARIO = {
    uk_card: 'uk_card',
    os_account_card_76: 'os_76_account_card',
    os_osv_08: 'os_08_osv',
    os_depreciation_01: 'os_01_hierarchy',
    os_wide_years: 'wide_metrics',
    opif_depo: 'opif_depo',
    opif_broker: 'opif_broker',
};

function getScenarioDef(scenarioId) {
    return SCENARIO_CATALOG[scenarioId] || null;
}

function listCatalogScenarios() {
    return Object.values(SCENARIO_CATALOG);
}

function scenarioFromProfileHint(hint) {
    return HINT_TO_SCENARIO[hint] || null;
}

function allowsTreeConfirm(scenarioId) {
    const def = getScenarioDef(scenarioId);
    if (!def) return false;
    return def.needsTree === 'yes' || def.needsTree === 'ask';
}

function blocksTree(scenarioId) {
    const def = getScenarioDef(scenarioId);
    return def?.needsTree === 'no';
}

function meetsConfidence(scenarioId, confidence) {
    const def = getScenarioDef(scenarioId);
    if (!def) return confidence >= 0.5;
    return confidence >= def.minConfidence;
}

function scenarioDisplayName(scenarioId) {
    return getScenarioDef(scenarioId)?.name || scenarioId || 'неизвестно';
}

module.exports = {
    SCENARIO_CATALOG,
    HINT_TO_SCENARIO,
    getScenarioDef,
    listCatalogScenarios,
    scenarioFromProfileHint,
    allowsTreeConfirm,
    blocksTree,
    meetsConfidence,
    scenarioDisplayName,
};
