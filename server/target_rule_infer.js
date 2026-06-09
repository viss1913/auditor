const { loadExample } = require('./ai_prompts');
const { matchMeasureFromHeader } = require('./excel_column_catalog');

const HIERARCHY_HEADER_MAP = [
    { re: /^юрлиц/i, source: { type: 'entity_from_header' } },
    { re: /^год$/i, source: { type: 'hierarchy_field', field: 'year' } },
    { re: /^групп/i, source: { type: 'hierarchy_field', field: 'group' } },
    { re: /^узел|^ртк$/i, source: { type: 'hierarchy_field', field: 'unit' } },
    { re: /^родител/i, source: { type: 'hierarchy_field', field: 'parent_unit' } },
    { re: /^подраздел|^оп$/i, source: { type: 'hierarchy_field', field: 'subdivision' } },
    { re: /^путь$/i, source: { type: 'hierarchy_field', field: 'path' } },
    { re: /^тип$|^назван|^наименован|^ос$/i, source: { type: 'hierarchy_field', field: 'asset_name' } },
];

function stripYearPrefix(header) {
    const m = String(header || '').trim().match(/^(\d{4})\s*[-–—]\s*(.+)$/i);
    if (m) return { year: m[1], label: m[2].trim() };
    return { year: null, label: String(header || '').trim() };
}

/** Маппинг заголовка эталона → measure (для «плоского» мэппинга без начало/конец в тексте) */
function inferMeasureFromTargetHeader(header, catalog) {
    const { year, label } = stripYearPrefix(header);
    const text = label.toLowerCase();

    if (/остаточн/i.test(text)) {
        if (/начал/i.test(text)) return 'residual_open';
        return 'residual_close';
    }
    if (/начислен/i.test(text) && /аморт/i.test(text)) return 'amort_charge';
    if (/аморт/i.test(text) && /износ/i.test(text) && !/начислен|списан/i.test(text)) {
        return /начал/i.test(text) ? 'amort_open' : 'amort_close';
    }
    if (/аморт/i.test(text) && !/списан/i.test(text)) {
        if (/начал/i.test(text)) return 'amort_open';
        if (/конец/i.test(text)) return 'amort_close';
        return 'amort_charge';
    }
    if (/стоимост/i.test(text) && !/остаточн/i.test(text)) {
        if (/начал/i.test(text)) return 'cost_open';
        if (/конец/i.test(text)) return 'cost_close';
        return 'cost_close';
    }
    if (/увеличен/i.test(text)) return 'cost_increase';
    if (/уменьшен/i.test(text)) return 'cost_decrease';
    if (/списан/i.test(text)) return 'amort_writeoff';

    const fromCatalog = (catalog?.metrics || []).find((m) => {
        const hp = (m.header_path || []).join(' ').toLowerCase();
        return hp.includes(text.slice(0, 12)) || text.includes(hp.slice(0, 12));
    });
    if (fromCatalog?.suggested_measure) return fromCatalog.suggested_measure;

    const guessed = matchMeasureFromHeader([label], -1);
    if (guessed) return guessed;

    return null;
}

function inferColumnFromTargetHeader(header, catalog) {
    const trimmed = String(header || '').trim();
    if (!trimmed) return null;

    const { label } = stripYearPrefix(trimmed);
    for (const entry of HIERARCHY_HEADER_MAP) {
        if (entry.re.test(label)) {
            return { target: trimmed, source: { ...entry.source } };
        }
    }

    const measure = inferMeasureFromTargetHeader(trimmed, catalog);
    if (measure) {
        return { target: trimmed, source: { type: 'metric', measure } };
    }
    return null;
}

/**
 * Собрать columns[] v2 из заголовков эталона — детерминированно, без LLM.
 * @param {string[]} targetHeaders
 * @param {Object} [catalog] column_catalog из analyze-layout
 */
function inferColumnsFromTargetHeaders(targetHeaders, catalog) {
    const cols = [];
    const seen = new Set();
    for (const h of targetHeaders || []) {
        const col = inferColumnFromTargetHeader(h, catalog);
        if (!col) continue;
        const key = `${col.source.type}:${col.source.field || col.source.measure || ''}:${col.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cols.push(col);
    }
    return cols;
}

/**
 * Применить эталон к правилу: columns = заголовки эталона, target = как в файле.
 */
function applyTargetToRule(rule, target, catalog) {
    const headers = target?.headers || [];
    if (!headers.length) return rule;

    const inferred = inferColumnsFromTargetHeaders(headers, catalog);
    if (!inferred.length) return rule;

    const yearFromHeaders = headers
        .map((h) => stripYearPrefix(h).year)
        .find(Boolean);

    const out = {
        ...rule,
        rule_schema_version: 2,
        meta: {
            ...(rule?.meta || {}),
            name: rule?.meta?.name || 'Правило из эталона',
            source_type: 'excel',
        },
        layout: {
            layout_type: 'hierarchy_rows',
            name_column: catalog?.name_column?.index ?? rule?.layout?.name_column ?? 0,
            ...(rule?.layout || {}),
        },
        hierarchy: rule?.hierarchy || loadExample('os_hierarchy_01.json').hierarchy,
        filters: rule?.filters || loadExample('os_hierarchy_01.json').filters,
        columns: inferred,
    };

    if (yearFromHeaders && !inferred.some((c) => c.source?.field === 'year')) {
        /* год уже может быть в columns */
    }

    return out;
}

function detectTargetKeyColumns(headers) {
    const candidates = ['ОС', 'тип', 'Тип', 'Объект', 'name', 'Название ОС', 'regNum', 'Наименование'];
    return candidates.filter((k) => headers.includes(k));
}

module.exports = {
    inferColumnsFromTargetHeaders,
    inferColumnFromTargetHeader,
    inferMeasureFromTargetHeader,
    applyTargetToRule,
    detectTargetKeyColumns,
    stripYearPrefix,
};
