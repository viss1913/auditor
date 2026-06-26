const { resolveColumnHint } = require('./result_table_commands');
const { extractColumnFilters, inferFilterOp } = require('./table_row_filter');

const DIMENSION_HINTS = [
    'подразделение',
    'контрагент',
    'договор',
    'счет',
    'счёт',
    'группа',
    'наименование',
];

const METRIC_HINTS = ['сальдо', 'оборот', 'amount', 'quantity', 'сумма', 'количество'];

const METRIC_STOP_RE = /\s+(?:всего\s+)?(?:оборот|сальдо|сумм|итого|колонк|столбц|где)\b/i;

const METRIC_ALIASES = [
    { re: /оборот\w*\s+(?:по\s+)?дт|оборот\w*\s+dt\b/i, hint: 'оборот дт' },
    { re: /оборот\w*\s+(?:по\s+)?кт|оборот\w*\s+kt\b/i, hint: 'оборот кт' },
    { re: /сальдо\w*\s+дт/i, hint: 'сальдо дт' },
    { re: /сальдо\w*\s+кт/i, hint: 'сальдо кт' },
];

function normalizeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9]+/g, ' ')
        .trim();
}

function cleanFragment(raw) {
    return String(raw || '')
        .trim()
        .replace(/[?!.:;]+$/g, '')
        .trim();
}

function isDimensionColumn(header) {
    const norm = normalizeText(header);
    return DIMENSION_HINTS.some((h) => norm.includes(h));
}

function isMetricColumn(header) {
    const norm = normalizeText(header);
    return METRIC_HINTS.some((h) => norm.includes(h));
}

function detectOpFromText(text) {
    const t = normalizeText(text);
    if (/непуст|заполнен|пустых/.test(t) && /сколько|колич|числ|count/.test(t)) {
        return 'count_non_empty';
    }
    if (/сколько\s+строк|число\s+строк|count\s+rows/.test(t)) return 'count';
    if (/миним|min\b|наименьш/.test(t)) return 'min';
    if (/максим|max\b|наибольш/.test(t)) return 'max';
    if (/средн|avg|average/.test(t)) return 'avg';
    if (/сумм|итого|посчитай|сложи|total|sum/.test(t)) return 'sum';
    if (/(?:^|\s)по\s+[а-яa-z0-9]/.test(t) || /(?:^|\s)по\s+(сальдо|оборот|колонк|столбц)/.test(t)) {
        return 'sum';
    }
    return null;
}

function trimFilterValueTail(raw) {
    let s = cleanFragment(raw);
    const stop = s.search(METRIC_STOP_RE);
    if (stop > 0) s = s.slice(0, stop).trim();
    const quoted = s.match(/^["«'](.+)["»']$/);
    if (quoted) return quoted[1].trim();
    const num = s.match(/^(\d+)/);
    if (num) return num[1];
    return s.split(/\s+/)[0] || s;
}

function isSuspiciousFilterValue(value) {
    const v = normalizeText(value);
    if (!v) return true;
    if (/оборот|сальдо|сумм|итого|колонк/.test(v)) return true;
    return v.split(/\s+/).length > 2;
}

function resolveFilterValue(column, rawValue, samplesByHeader = {}) {
    const val = trimFilterValueTail(rawValue);
    if (!val) return val;
    const samples = samplesByHeader[column] || [];
    const normVal = normalizeText(val);

    for (const sample of samples) {
        if (normalizeText(sample) === normVal) return sample;
    }
    for (const sample of samples) {
        const normSample = normalizeText(sample);
        if (normSample.includes(normVal) || normVal.includes(normSample)) return sample;
    }
    if (/^\d+$/.test(val)) {
        for (const sample of samples) {
            const tokens = normalizeText(sample).split(/\s+/).filter(Boolean);
            if (tokens[tokens.length - 1] === normVal) return sample;
        }
    }
    return val;
}

function inferDimensionFilterOp(column, value, samplesByHeader = {}) {
    const v = String(value || '').trim();
    if (!v) return 'eq';
    if (!isDimensionColumn(column)) return inferFilterOp(column, value);
    const resolved = resolveFilterValue(column, v, samplesByHeader);
    const samples = samplesByHeader[column] || [];
    if (samples.some((s) => normalizeText(s) === normalizeText(resolved))) return 'eq';
    if (/^\d+$/.test(v) || /^\d+$/.test(trimFilterValueTail(v))) return 'eq';
    return 'contains';
}

const DIMENSION_STEMS = {
    подразделен: 'подразделение',
    контрагент: 'контрагент',
    договор: 'договор',
};

function resolveDimensionColumn(hint, headers) {
    const norm = normalizeText(hint);
    for (const [prefix, canonical] of Object.entries(DIMENSION_STEMS)) {
        if (norm.startsWith(prefix)) {
            return resolveColumnHint(canonical, headers);
        }
    }
    return resolveColumnHint(hint, headers);
}

function extractGroupBy(text, headers) {
    const patterns = [
        /(?:по\s+кажд[а-яёa-z0-9_]*|группир[а-яёa-z0-9_]*|разб[а-яёa-z0-9_]*)\s+(?:по\s+)?["«']?([^"»'\n,.]+)/i,
        /(?:для\s+кажд[а-яёa-z0-9_]*)\s+["«']?([^"»'\n,.]+)/i,
        /group\s+by\s+["«']?([^"»'\n,.]+)/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]) {
            const col = resolveDimensionColumn(cleanFragment(m[1]), headers) ||
                resolveColumnHint(cleanFragment(m[1]), headers);
            if (col) return col;
        }
    }
    return null;
}

function extractDimensionFilters(text, headers, samplesByHeader) {
    const filters = [];
    const seen = new Set();

    const dimensionRes = [
        /(?:^|\s)по\s+(подразделен[а-яёa-z0-9_]*)\s+(.+?)(?:\s+и\s+|$)/gi,
        /(?:^|\s)по\s+(контрагент[а-яёa-z0-9_]*)\s+(.+?)(?:\s+и\s+|$)/gi,
        /(?:^|\s)по\s+(договор[а-яёa-z0-9_]*)\s+(.+?)(?:\s+и\s+|$)/gi,
        /(?:^|\s)где\s+(подразделен[а-яёa-z0-9_]*|контрагент[а-яёa-z0-9_]*|договор[а-яёa-z0-9_]*)\s*[=:]?\s*(.+?)(?:\s+и\s+|$)/gi,
    ];

    for (const re of dimensionRes) {
        let m;
        while ((m = re.exec(text)) !== null) {
            const col = resolveDimensionColumn(m[1], headers);
            if (!col) continue;
            const value = resolveFilterValue(col, m[2], samplesByHeader);
            if (!value || isSuspiciousFilterValue(value)) continue;
            const key = `${col}::${value}`;
            if (seen.has(key)) continue;
            seen.add(key);
            filters.push({
                column: col,
                op: inferDimensionFilterOp(col, value, samplesByHeader),
                value,
            });
        }
    }

    return filters;
}

function headerMentionedInText(t, headerNorm) {
    if (!headerNorm) return false;
    if (t.includes(headerNorm)) return true;
    const words = headerNorm.split(/\s+/).filter((w) => w.length > 1);
    if (words.length < 2) return t.includes(words[0] || headerNorm);
    let pos = 0;
    for (const w of words) {
        const stem = w.length > 4 ? w.slice(0, w.length - 1) : w;
        const idx = t.indexOf(stem, pos);
        if (idx < 0) return false;
        pos = idx + stem.length;
    }
    return true;
}

function findHeaderInText(text, headers, { preferMetric = false, exclude = [] } = {}) {
    const t = normalizeText(text);
    const excluded = new Set(exclude);
    const candidates = (headers || []).filter((h) => !excluded.has(h));

    const scored = candidates
        .map((h) => {
            const norm = normalizeText(h);
            if (!norm || !headerMentionedInText(t, norm)) return null;
            let score = norm.length;
            if (preferMetric && isMetricColumn(h)) score += 100;
            if (!preferMetric && isDimensionColumn(h)) score += 50;
            return { header: h, score };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

    return scored[0]?.header || null;
}

function extractMetricColumn(text, headers, exclude = []) {
    const parts = String(text || '').split(/\s+и\s+/i);
    if (parts.length > 1) {
        const right = parts[parts.length - 1];
        const fromRight = resolveColumnHint(cleanFragment(right), headers);
        if (fromRight && !exclude.includes(fromRight)) return fromRight;
        const fromRightHeader = findHeaderInText(right, headers, {
            preferMetric: true,
            exclude,
        });
        if (fromRightHeader) return fromRightHeader;
    }

    for (const { re, hint } of METRIC_ALIASES) {
        if (re.test(text)) {
            const col = resolveColumnHint(hint, headers);
            if (col && !exclude.includes(col)) return col;
        }
    }

    return findHeaderInText(text, headers, { preferMetric: true, exclude });
}

function hasExplicitFilterPattern(text) {
    return /(?:^|\s)по\s+(подразделен[а-яёa-z0-9_]*|контрагент[а-яёa-z0-9_]*|договор[а-яёa-z0-9_]*)\s+\S/i.test(
        text
    );
}

function isCompoundUncertain(text, clauses) {
    if (!hasExplicitFilterPattern(text)) return false;
    if (clauses.filters?.length) return false;
    return true;
}

/**
 * @returns {{ op, column, groupBy, filters, mode, combine, uncertain }}
 */
function parseAggregateClauses(message, headers = [], samplesByHeader = {}) {
    const text = String(message || '').trim();
    const op = detectOpFromText(text) || 'sum';
    const brokerExtracted = extractColumnFilters(text, headers);
    const dimensionFilters = extractDimensionFilters(text, headers, samplesByHeader);

    const filters = [];
    const seen = new Set();
    for (const f of [...brokerExtracted.filters, ...dimensionFilters]) {
        const key = `${f.column}::${f.value}::${f.op}`;
        if (seen.has(key)) continue;
        seen.add(key);
        filters.push(f);
    }

    const filterColumns = new Set(filters.map((f) => f.column));
    const groupBy = extractGroupBy(text, headers);

    let column = null;
    if (op !== 'count') {
        column = extractMetricColumn(text, headers, groupBy ? [groupBy] : [...filterColumns]);
        if (!column && groupBy) {
            column = findHeaderInText(text, headers, {
                preferMetric: true,
                exclude: [groupBy, ...filterColumns],
            });
        }
    }

    const uncertain =
        isCompoundUncertain(text, { filters }) || (hasExplicitFilterPattern(text) && !column && op !== 'count');

    return {
        op,
        column,
        groupBy: groupBy && !filterColumns.has(groupBy) ? groupBy : null,
        filters,
        mode: brokerExtracted.mode || 'keep',
        combine: 'and',
        uncertain,
    };
}

module.exports = {
    parseAggregateClauses,
    hasExplicitFilterPattern,
    isCompoundUncertain,
    normalizeText,
    detectOpFromText,
    trimFilterValueTail,
    resolveFilterValue,
    inferDimensionFilterOp,
};
