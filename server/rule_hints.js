const { loadExample } = require('./ai_prompts');
const { matchUserTextToMeasures, measuresToRuleColumns } = require('./excel_column_catalog');

function applyV2HintsFromUserMessage(rule, userText, layoutMeta, columnCatalog) {
    if (!rule) return rule;
    const t = String(userText || '').toLowerCase();
    const catalog = columnCatalog || layoutMeta?.column_catalog;
    if (!t && !layoutMeta && !catalog) return rule;

    rule.rule_schema_version = 2;
    rule.meta = rule.meta || { name: 'Правило из диалога', source_type: 'excel' };
    rule.meta.source_type = 'excel';
    rule.layout = rule.layout || { layout_type: 'hierarchy_rows', name_column: 0 };
    rule.hierarchy = rule.hierarchy || { leaf_rules: loadExample('os_hierarchy_01.json').hierarchy.leaf_rules };
    rule.filters = rule.filters || { skip_row_patterns: ['^Итого', '^Группа учета', '^Ведомость', '^Выводимые'] };

    if (/08|оборотно-сальдов/i.test(t)) {
        rule.layout.layout_type = 'hierarchy_osv';
        rule.meta.sheet_name = rule.meta.sheet_name || 'Исходная выгрузка 08';
        return rule;
    }

    if (!rule.layout.layout_type || rule.layout.layout_type === 'table') {
        rule.layout.layout_type =
            catalog?.layout_type || layoutMeta?.recommended?.layout_type || 'hierarchy_rows';
    }
    if (/wide|год.*колонк/i.test(t)) {
        rule.layout.layout_type = 'wide_metrics';
    }

    if (!rule.meta.sheet_name) {
        rule.meta.sheet_name =
            catalog?.sheet ||
            layoutMeta?.recommended?.suggested_sheet ||
            layoutMeta?.sheetName ||
            (layoutMeta?.sheetNames || []).find((s) => /исходн.*01/i.test(s)) ||
            'Исходная выгрузка 01';
    }

    if (catalog?.name_column != null) {
        rule.layout.name_column = catalog.name_column.index;
    } else if (/колонк[аеи]?\s*([абвг])|column\s*([a-d])/i.test(t)) {
        rule.layout.name_column = 0;
    }

    let cols = Array.isArray(rule.columns) ? [...rule.columns] : [];
    const hierarchyCols = cols.filter((c) => c.source?.type !== 'metric' && !/^год$/i.test(c.target));
    let metrics = cols.filter((c) => c.source?.type === 'metric');
    const yearLabel =
        (t.match(/20\d{2}/) || [])[0] || catalog?.report_year || layoutMeta?.column_catalog?.report_year || '2024';

    if (catalog && t) {
        const match = matchUserTextToMeasures(userText, catalog, yearLabel);
        const fromCatalog = measuresToRuleColumns(match, catalog);
        if (fromCatalog.length) {
            metrics = fromCatalog;
        } else if (match.exclude_amort && metrics.length) {
            metrics = metrics.filter((c) => !/amort/i.test(c.source?.measure || ''));
        }
    }

    const wantsCostStart = /стоимост/i.test(t) && /начал/i.test(t);
    const wantsEnd = /конец/i.test(t) || /остаточн/i.test(t);
    const wantsResidualEnd = /остаточн/i.test(t) && wantsEnd;
    const wantsName =
        /назван|наименован|основн|средств|колонк/i.test(t) || metrics.length === 0;

    if (metrics.length === 0 && (wantsCostStart || wantsEnd || /без\s+амортизац/i.test(t))) {
        metrics = [];
        if (wantsCostStart || !wantsEnd) {
            metrics.push({
                target: `${yearLabel} - стоимость на начало`,
                source: { type: 'metric', measure: 'cost_open' },
            });
        }
        if (wantsEnd) {
            metrics.push({
                target: wantsResidualEnd
                    ? `${yearLabel} - остаточная на конец`
                    : `${yearLabel} - стоимость на конец`,
                source: {
                    type: 'metric',
                    measure: wantsResidualEnd ? 'residual_close' : 'cost_close',
                },
            });
        }
    }

    if (/без\s+амортизац/i.test(t)) {
        metrics = metrics.filter((c) => !/amort/i.test(c.source?.measure || ''));
    }

    const outCols = [];
    if (wantsName) {
        const hasAsset = hierarchyCols.some(
            (c) => c.source?.field === 'asset_name' || /назван|ос$/i.test(c.target)
        );
        if (!hasAsset) {
            outCols.push({
                target: 'Название ОС',
                source: { type: 'hierarchy_field', field: 'asset_name' },
            });
        }
    }
    if ((/год/i.test(t) || catalog?.report_year) && !hierarchyCols.some((c) => /^год$/i.test(c.target))) {
        outCols.push({ target: 'Год', source: { type: 'hierarchy_field', field: 'year' } });
    }

    const removeColumnIntent = /(удал\S*|убер\S*|remove|delete)\s+колонк/i.test(t);
    const includeGroup = !removeColumnIntent && /групп|подраздел|оп\s|ртк|иерарх/i.test(t);
    const wantsFullHierarchy = /ртк|узел|родител|с\s+групп|с\s+оп/i.test(t);

    function normalizeText(s) {
        return String(s || '')
            .toLowerCase()
            .replace(/[ё]/g, 'е')
            .replace(/[^a-zа-я0-9]+/g, ' ')
            .trim();
    }

    function tokenize(s) {
        return normalizeText(s)
            .split(' ')
            .map((x) => x.trim())
            .filter(Boolean);
    }

    const removeRequestRaw = (() => {
        const m =
            t.match(/(?:удал\S*|убер\S*|remove|delete)\s+(?:колонк[ауи]?|column)\s+["«']?([^"»'\n]+)/i) ||
            t.match(/(?:remove|delete)\s+column\s+["']?([^"'\n]+)/i);
        return m?.[1]?.trim() || '';
    })();
    const removeRequestTokens = tokenize(removeRequestRaw);

    function matchesRemoveRequest(col) {
        if (!removeRequestTokens.length) return false;
        const req = normalizeText(removeRequestRaw);
        const measure = String(col.source?.measure || '');
        // explicit semantic mapping for common metric phrases
        if (/остаточ/.test(req) && /конец/.test(req) && measure === 'residual_close') return true;
        if (/амортиз/.test(req) && /конец/.test(req) && measure === 'amort_close') return true;
        if (/стоимост/.test(req) && /конец/.test(req) && measure === 'cost_close') return true;
        if (/стоимост/.test(req) && /начал/.test(req) && measure === 'cost_open') return true;
        if (/амортиз/.test(req) && /начал/.test(req) && measure === 'amort_open') return true;

        const candidates = [
            col.target,
            col.source?.field,
            col.source?.measure,
            col.source?.period_suffix,
        ]
            .filter(Boolean)
            .map((x) => tokenize(x));
        return candidates.some((tok) => removeRequestTokens.every((tkn) => tok.includes(tkn)));
    }

    if (wantsFullHierarchy) {
        if (!hierarchyCols.some((c) => c.source?.field === 'unit')) {
            outCols.push({ target: 'Узел', source: { type: 'hierarchy_field', field: 'unit' } });
        }
        if (!hierarchyCols.some((c) => c.source?.field === 'parent_unit')) {
            outCols.push({
                target: 'Родитель',
                source: { type: 'hierarchy_field', field: 'parent_unit' },
            });
        }
    }
    if (includeGroup) {
        for (const d of [
            { target: 'Группа', source: { type: 'hierarchy_field', field: 'group' } },
            { target: 'Подразделение', source: { type: 'hierarchy_field', field: 'subdivision' } },
        ]) {
            if (!hierarchyCols.some((c) => c.source?.field === d.source.field)) outCols.push(d);
        }
    }

    for (const c of hierarchyCols) {
        if (matchesRemoveRequest(c)) continue;
        if (
            !includeGroup &&
            (c.target === 'Группа' ||
                c.target === 'Подразделение' ||
                c.source?.field === 'group' ||
                c.source?.field === 'subdivision')
        )
            continue;
        if (
            !wantsFullHierarchy &&
            (c.source?.field === 'unit' || c.source?.field === 'parent_unit' || c.source?.field === 'path')
        )
            continue;
        if (outCols.some((o) => o.source?.field === c.source?.field && o.target === c.target)) continue;
        outCols.push(c);
    }

    const finalMetrics = metrics.filter((m) => !matchesRemoveRequest(m));
    rule.columns = [...outCols, ...finalMetrics];
    return rule;
}

function bootstrapRuleFromUserMessage(userText, layoutMeta) {
    const base = loadExample('os_hierarchy_01.json');
    base.meta.name = 'Правило из диалога';
    return applyV2HintsFromUserMessage(base, userText, layoutMeta, layoutMeta?.column_catalog);
}

module.exports = {
    applyV2HintsFromUserMessage,
    bootstrapRuleFromUserMessage,
};
