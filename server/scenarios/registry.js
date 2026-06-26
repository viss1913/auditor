const path = require('path');
const fs = require('fs');
const { loadExample } = require('../ai_prompts');
const { applyTargetToRule } = require('../target_rule_infer');
const { applyTreeProfileToRule } = require('../tree_profiles');

const PRESETS_DIR = path.join(__dirname, 'presets');

/** Порядок как в Excel: начало → за период → конец */
const DEFAULT_MEASURES = [
    'cost_open',
    'amort_open',
    'residual_open',
    'cost_increase',
    'amort_charge',
    'cost_decrease',
    'amort_writeoff',
    'cost_close',
    'amort_close',
    'residual_close',
];

const COST_ONLY_MEASURES = ['cost_open', 'cost_close'];

/** Формат ТЗ ФАС / мэппинг: остаточная на начало → амортизация → остаточная на конец */
const FAS_TZ_MEASURES = ['residual_open', 'amort_charge', 'residual_close'];

const TZ_MEASURE_LABELS = {
    residual_open: 'начало',
    amort_charge: 'амортизация',
    residual_close: 'конец',
};

function loadPresetDescriptors() {
    const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8')));
}

function getTreeSample(layoutMeta) {
    const fromInference = layoutMeta?.tree_inference?.examples;
    if (fromInference?.length) {
        return fromInference.map((e) => ({
            path: e.path || [],
            leaf_name: e.leaf_name || '',
        }));
    }
    return (
        layoutMeta?.hierarchy_tree_sample ||
        layoutMeta?.column_catalog?.hierarchy_tree_sample ||
        []
    );
}

function hasDeepTree(layoutMeta) {
    if (
        layoutMeta?.structure_id === 'tree_os_08' ||
        layoutMeta?.recommended?.profile_hint === 'os_osv_08' ||
        layoutMeta?.column_catalog?.layout_type === 'hierarchy_osv'
    ) {
        return false;
    }
    const sample = getTreeSample(layoutMeta);
    return sample.some((r) => Array.isArray(r.path) && r.path.length >= 2);
}

/** Карточка счёта 76 (договоры + контрагенты), не ОСВ 08 по объектам. */
function isAccountCard76(layoutMeta) {
    if (layoutMeta?.recommended?.profile_hint === 'uk_card') return false;
    const ti = layoutMeta?.tree_inference;
    if (ti?.profileId === 'account_card' || ti?.profileKey === 'os_76_card') return true;
    const counts = ti?.clusterCounts;
    if ((counts?.contract || 0) > 0 && (counts?.counterparty || 0) > 0) return true;
    const catalog = layoutMeta?.column_catalog;
    if (catalog?.hierarchy_legend && catalog?.layout_type === 'hierarchy_osv') return true;
    if (layoutMeta?.recommended?.profile_hint === 'os_account_card_76') return true;
    return false;
}

function isAccountCard76Data(data, startRow = 0) {
    let hasContract = false;
    let hasCounterparty = false;
    let has76 = false;
    for (let i = startRow; i < (data || []).length; i++) {
        const label = String(data[i]?.[0] ?? '').trim();
        if (!label) continue;
        if (/^Договор\s/i.test(label)) hasContract = true;
        if (/^Контрагент/i.test(label)) hasCounterparty = true;
        if (/^76(\.|,|\s)/.test(label)) has76 = true;
    }
    return hasContract && hasCounterparty && has76;
}

function inferScenarioFromRule(rule) {
    if (!rule?.columns) return 'os_01_flat';
    if (rule.meta?.profile_hint === 'os_account_card') return 'os_76_account_card';
    const targets = rule.columns.map((c) => c.target).join(' ');
    if (/Договор/.test(targets) && /Контрагент/.test(targets)) return 'os_76_account_card';
    if (/Группа|Узел|Подразделение/.test(targets) && !/Договор/.test(targets)) return 'os_01_hierarchy';
    if (rule.layout?.layout_type === 'hierarchy_osv') return 'os_08_osv';
    if (rule.layout?.layout_type === 'fixed_columns') return null;
    return 'os_01_flat';
}

function detectSuggestedScenario(layoutMeta, target) {
    if (target?.headers?.length) {
        return { scenarioId: 'from_target', needsUserChoice: false };
    }
    const structureId =
        layoutMeta?.structure_id ||
        layoutMeta?.structure?.structure_id ||
        layoutMeta?.ontology?.suggested_structure_id;
    if (structureId === 'tree_os_08') {
        return { scenarioId: 'os_08_osv', needsUserChoice: false };
    }
    if (structureId === 'tree_account_76') {
        return { scenarioId: 'os_76_account_card', needsUserChoice: false };
    }
    const ontology = layoutMeta?.ontology;
    if (ontology?.parser_rule?.scenarioId) {
        return { scenarioId: ontology.parser_rule.scenarioId, needsUserChoice: false };
    }
    const layoutType = layoutMeta?.recommended?.layout_type || layoutMeta?.column_catalog?.layout_type;
    if (
        layoutMeta?.recommended?.profile_hint === 'uk_card' ||
        ontology?.row_pattern === 'bu_kol_pairs' ||
        (layoutType === 'fixed_columns' && layoutMeta?.column_catalog?.uk_quantity_detect)
    ) {
        return { scenarioId: 'uk_card', needsUserChoice: false };
    }
    if (layoutMeta?.recommended?.profile_hint === 'os_wide_years' || layoutType === 'wide_metrics') {
        return { scenarioId: 'wide_metrics', needsUserChoice: false };
    }
    if (layoutType === 'hierarchy_osv') {
        if (isAccountCard76(layoutMeta)) {
            return { scenarioId: 'os_76_account_card', needsUserChoice: false };
        }
        return { scenarioId: 'os_08_osv', needsUserChoice: false };
    }
    if (hasDeepTree(layoutMeta)) {
        return {
            scenarioId: null,
            needsUserChoice: true,
            candidates: ['os_01_flat', 'os_01_hierarchy'],
        };
    }
    return { scenarioId: 'os_01_flat', needsUserChoice: false };
}

function resolveScenarioFromMessage(userText, hasTarget) {
    const t = String(userText || '').toLowerCase();
    if (!t) return null;
    if (/эталон|как в пример|как в файле target/i.test(t) && hasTarget) return 'from_target';
    if (/карточк|договор|контрагент|76(\.|$|\s)/i.test(t)) return 'os_76_account_card';
    if (/08|осв|оборотно-сальдов/i.test(t)) return 'os_08_osv';
    if (/без\s+амортизац|cost_only|только\s+стоимост/i.test(t)) return 'os_01_cost_only';
    if (/плоск|только\s+ос|только\s+тип|без\s+групп|без\s+иерарх|без\s+дерев/i.test(t)) return 'os_01_flat';
    if (/групп|ртк|иерарх|дерев|с\s+оп|узел|разверн/i.test(t)) return 'os_01_hierarchy';
    return null;
}

function layoutTypeForScenario(scenarioId) {
    if (scenarioId === 'os_76_account_card' || scenarioId === 'os_08_osv') return 'hierarchy_osv';
    if (scenarioId === 'wide_metrics') return 'wide_metrics';
    if (scenarioId === 'uk_card') return 'fixed_columns';
    if (scenarioId === 'os_01_hierarchy' || scenarioId === 'os_01_flat' || scenarioId === 'os_01_cost_only') {
        return 'hierarchy_rows';
    }
    return null;
}

function applyLayoutMeta(base, layoutMeta, catalog, scenarioId) {
    if (layoutMeta?.sheetName) {
        base.meta.sheet_name = layoutMeta.sheetName;
    } else if (layoutMeta?.recommended?.suggested_sheet) {
        base.meta.sheet_name = layoutMeta.recommended.suggested_sheet;
    }
    const forcedLayout = layoutTypeForScenario(scenarioId);
    if (forcedLayout) {
        base.layout.layout_type = forcedLayout;
    } else if (catalog?.layout_type) {
        base.layout.layout_type = catalog.layout_type;
    } else if (layoutMeta?.recommended?.layout_type) {
        base.layout.layout_type = layoutMeta.recommended.layout_type;
    }
    if (catalog?.name_column != null) {
        base.layout.name_column = catalog.name_column.index;
    } else if (catalog?.sheet) {
        base.meta.sheet_name = base.meta.sheet_name || catalog.sheet;
    }
    if (catalog?.data_start_row != null) {
        base.layout.data_start_row = catalog.data_start_row;
    }
}

function metricsFromCatalog(catalog, year, allowedMeasures) {
    const cols = [];
    const seen = new Set();
    for (const m of catalog?.metrics || []) {
        if (!m.suggested_measure || !allowedMeasures.includes(m.suggested_measure)) continue;
        if (seen.has(m.suggested_measure)) continue;
        seen.add(m.suggested_measure);
        const label =
            TZ_MEASURE_LABELS[m.suggested_measure] ||
            (m.header_path || []).join(' — ') ||
            m.suggested_measure;
        cols.push({
            target: `${year} - ${label}`,
            source: { type: 'metric', measure: m.suggested_measure },
        });
    }
    if (cols.length === 0 && allowedMeasures.includes('residual_close')) {
        for (const measure of allowedMeasures) {
            const label = TZ_MEASURE_LABELS[measure] || measure;
            cols.push({
                target: `${year} - ${label}`,
                source: { type: 'metric', measure },
            });
        }
    }
    return cols;
}

function buildFlatColumns(catalog, year) {
    return [
        { target: 'год', source: { type: 'hierarchy_field', field: 'year' } },
        { target: 'тип', source: { type: 'hierarchy_field', field: 'asset_name' } },
        ...metricsFromCatalog(catalog, year, FAS_TZ_MEASURES),
    ];
}

function buildHierarchyColumns(catalog, year) {
    return [
        { target: 'Юрлицо', source: { type: 'entity_from_header' } },
        { target: 'Группа', source: { type: 'hierarchy_field', field: 'group' } },
        { target: 'Узел', source: { type: 'hierarchy_field', field: 'unit' } },
        { target: 'Подразделение', source: { type: 'hierarchy_field', field: 'subdivision' } },
        { target: 'ОС', source: { type: 'hierarchy_field', field: 'asset_name' } },
        ...metricsFromCatalog(catalog, year, FAS_TZ_MEASURES),
    ];
}

function applyScenario(scenarioId, layoutMeta, target) {
    const catalog = layoutMeta?.column_catalog;
    const year = catalog?.report_year || '2024';

    if (scenarioId === 'from_target' && target?.headers?.length) {
        const base = JSON.parse(JSON.stringify(loadExample('os_hierarchy_01.json')));
        applyLayoutMeta(base, layoutMeta, catalog, scenarioId);
        return applyTargetToRule(base, target, catalog);
    }

    if (scenarioId === 'uk_card') {
        const ukMode =
            layoutMeta?.uk_mode ||
            layoutMeta?.uk_probe?.mode ||
            (layoutMeta?.sessionUkMode === 'trades' ? 'trades' : 'full');
        const ruleFile = ukMode === 'trades' ? 'uk_card_trades.json' : 'uk_card.json';
        const rule = JSON.parse(JSON.stringify(loadExample(ruleFile)));
        applyLayoutMeta(rule, layoutMeta, catalog, scenarioId);

        const probe = layoutMeta?.uk_probe;
        const qty =
            layoutMeta?.uk_quantity_column ??
            probe?.quantity_column ??
            layoutMeta?.uk_quantity_detect?.suggested ??
            rule.multi_row?.quantity_column;
        if (qty != null) {
            rule.multi_row.quantity_column = qty;
        }
        const skip =
            probe?.skip_rows ?? catalog?.data_start_row ?? rule.layout?.skip_rows;
        if (skip != null) {
            rule.layout.skip_rows = skip;
        }

        const columnRoles = {
            period: probe?.period_column,
            document: probe?.document_column,
            analytics: probe?.analytics_column,
            analytics_kt: probe?.analytics_kt_column,
            indicator: probe?.indicator_column,
            debit_account: probe?.debit_account_column,
            amount: probe?.amount_column,
            credit_account: probe?.credit_account_column,
            balance_side: probe?.balance_side_column,
            balance: probe?.balance_column,
        };
        for (const [role, col] of Object.entries(columnRoles)) {
            if (col == null) continue;
            rule.column_map[role] = col;
        }
        if (probe?.indicator_column != null) {
            rule.multi_row.indicator_column = probe.indicator_column;
        }
        if (probe?.amount_column != null) {
            rule.multi_row.amount_column = probe.amount_column;
        }
        if (probe?.balance_column != null) {
            rule.multi_row.balance_column = probe.balance_column;
            rule.column_map.balance = probe.balance_column;
        }
        if (probe?.balance_side_column != null) {
            rule.multi_row.balance_side_column = probe.balance_side_column;
            rule.column_map.balance_side = probe.balance_side_column;
        }
        const balBuCol = rule.columns.find((c) => c.target === 'current_balance_bu');
        const balQtyCol = rule.columns.find((c) => c.target === 'current_balance_qty');
        if (balBuCol && probe?.balance_column != null) balBuCol.source.column = probe.balance_column;
        if (balQtyCol && probe?.balance_column != null) balQtyCol.source.column = probe.balance_column;
        if (probe?.document_column != null && probe.has_document_column !== false) {
            const docCol = rule.columns.find((c) => c.target === 'document');
            const opCol = rule.columns.find((c) => c.target === 'operation_type');
            if (docCol) docCol.source.column = probe.document_column;
            if (opCol) opCol.source.column = probe.document_column;
        }
        const colTargetMap = {
            period: 'period',
            document: 'document',
            name: 'analytics',
            'Аналитика Дт': 'analytics',
            'Аналитика Кт': 'analytics_kt',
            amount: 'amount',
            quantity: 'quantity',
            debit_account: 'debit_account',
            credit_account: 'credit_account',
        };
        for (const [target, role] of Object.entries(colTargetMap)) {
            const col = columnRoles[role === 'analytics' ? 'analytics' : role];
            if (col == null) continue;
            const colDef = rule.columns.find((c) => c.target === target);
            if (colDef?.source?.type === 'fixed_cell') colDef.source.column = col;
        }
        if (layoutMeta?.sheetName) {
            rule.meta.sheet_name = layoutMeta.sheetName;
        }
        return rule;
    }

    if (scenarioId === 'wide_metrics') {
        const rule = JSON.parse(JSON.stringify(loadExample('os_wide_years.json')));
        applyLayoutMeta(rule, layoutMeta, catalog, scenarioId);
        rule.meta.name = 'Ведомость ОС — годы в колонках';
        rule.meta.profile_hint = 'os_wide_years';
        if (catalog?.metrics?.length) {
            const year = catalog.report_year || '2024';
            rule.columns = [
                { target: 'Юрлицо', source: { type: 'entity_from_header' } },
                { target: 'Группа', source: { type: 'hierarchy_field', field: 'group' } },
                { target: 'Подразделение', source: { type: 'hierarchy_field', field: 'subdivision' } },
                { target: 'ОС', source: { type: 'hierarchy_field', field: 'asset_name' } },
                ...metricsFromCatalog(catalog, year, DEFAULT_MEASURES),
            ];
        }
        return rule;
    }

    if (scenarioId === 'os_76_account_card') {
        const rule = JSON.parse(JSON.stringify(loadExample('os_hierarchy_08.json')));
        applyLayoutMeta(rule, layoutMeta, catalog, scenarioId);
        rule.meta.name = 'Карточка счёта — дерево в плоскую таблицу';
        rule.meta.profile_hint = 'os_account_card';
        rule.columns = [
            { target: 'Счёт, наименование счета', source: { type: 'hierarchy_field', field: 'account' } },
            { target: 'Подразделение', source: { type: 'hierarchy_field', field: 'subdivision' } },
            { target: 'Контрагент', source: { type: 'hierarchy_field', field: 'counterparty' } },
            { target: 'Договор', source: { type: 'hierarchy_field', field: 'contract' } },
            { target: 'Сальдо Дт начало', source: { type: 'osv_turnover', field: 'saldo_dt_open' } },
            { target: 'Сальдо Кт начало', source: { type: 'osv_turnover', field: 'saldo_kt_open' } },
            { target: 'Оборот Дт', source: { type: 'osv_turnover', field: 'turnover_dt' } },
            { target: 'Оборот Кт', source: { type: 'osv_turnover', field: 'turnover_kt' } },
            { target: 'Сальдо Дт конец', source: { type: 'osv_turnover', field: 'saldo_dt_close' } },
            { target: 'Сальдо Кт конец', source: { type: 'osv_turnover', field: 'saldo_kt_close' } },
        ];
        applyTreeProfileToRule(rule, 'os_76_card');
        return rule;
    }

    if (scenarioId === 'os_08_osv') {
        const rule = JSON.parse(JSON.stringify(loadExample('os_hierarchy_08.json')));
        applyLayoutMeta(rule, layoutMeta, catalog, scenarioId);
        rule.meta.name = 'ОСВ 08';
        applyTreeProfileToRule(rule, 'os_08');
        return rule;
    }

    if (scenarioId === 'os_01_cost_only') {
        const rule = JSON.parse(JSON.stringify(loadExample('os_hierarchy_01_cost_only.json')));
        applyLayoutMeta(rule, layoutMeta, catalog, scenarioId);
        return rule;
    }

    if (scenarioId === 'os_01_hierarchy') {
        const rule = JSON.parse(JSON.stringify(loadExample('os_hierarchy_01.json')));
        applyLayoutMeta(rule, layoutMeta, catalog, scenarioId);
        rule.meta.name = 'Ведомость ОС — с иерархией';
        const yearCols = buildHierarchyColumns(catalog, year);
        rule.columns = yearCols;
        applyTreeProfileToRule(rule, 'os_01');
        return rule;
    }

    // os_01_flat (default)
    const rule = JSON.parse(JSON.stringify(loadExample('os_hierarchy_01.json')));
    applyLayoutMeta(rule, layoutMeta, catalog, scenarioId);
    rule.meta.name = 'Ведомость ОС — плоская таблица';
    rule.columns = buildFlatColumns(catalog, year);
    return rule;
}

function buildScenarioChoiceMessage(layoutMeta) {
    const sample = getTreeSample(layoutMeta).slice(0, 2);
    const examples = sample
        .map((r) => `• ${(r.path || []).join(' → ')} → ${(r.leaf_name || '').slice(0, 40)}…`)
        .join('\n');
    return (
        `В колонке A **дерево** (группа → узел → ОП → ОС).\n\n` +
        (examples ? `Примеры:\n${examples}\n\n` : '') +
        `**Как развернуть в таблицу?**\n` +
        `• **Плоская** — год, тип (название ОС), метрики\n` +
        `• **С иерархией** — группа, узел (РТК/КЦ), подразделение (ОП), ОС, метрики\n\n` +
        `Выбери сценарий кнопкой ниже или напиши «плоско» / «с группой и ОП».`
    );
}

function listScenarios() {
    return loadPresetDescriptors();
}

module.exports = {
    listScenarios,
    detectSuggestedScenario,
    resolveScenarioFromMessage,
    applyScenario,
    buildScenarioChoiceMessage,
    getTreeSample,
    hasDeepTree,
    isAccountCard76,
    isAccountCard76Data,
    inferScenarioFromRule,
    layoutTypeForScenario,
    applyLayoutMeta,
};
