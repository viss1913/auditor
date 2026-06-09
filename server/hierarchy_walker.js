const GROUP_HINT =
    /^(Здания|Сооружения|Машины|Земельные|Транспорт|Офисное|Производственный|Другие виды)/i;

const DEFAULT_LEVELS = [
    {
        id: 'group',
        depth: 0,
        patterns: ['^(Здания|Сооружения|Машины|Земельные|Транспорт|Офисное|Производственный|Другие виды)'],
    },
    { id: 'unit', depth: 1, patterns: ['^РТК\\s', '^КЦ$'] },
    { id: 'branch', depth: 2, patterns: ['^ОП\\s'] },
];

const HEADER_SKIP = /^(Группа учета|Подразделение|Основное средство|Выводимые данные|Ведомость)/i;

function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

function compilePatterns(levels) {
    return levels.map((lvl) => ({
        ...lvl,
        regexes: (lvl.patterns || []).map((p) => new RegExp(p, 'i')),
    }));
}

function buildLeafChecker(leafRules) {
    const ld = leafRules || {};
    const minLen = ld.min_name_length ?? 20;
    const invRes = (ld.inventory_patterns || [
        '\\d{2}\\.\\d{2}\\.\\d{4}',
        'инв\\.?',
        '№\\s*[\\dA-Z-]',
        '80-\\d+',
        '\\d{6,}',
    ]).map((p) => new RegExp(p, 'i'));
    const skipRes = (ld.skip_name_patterns || ['^ОП\\s', '^РТК\\s', '^КЦ$', '^Итого']).map(
        (p) => new RegExp(p, 'i')
    );
    return (name) => {
        const t = String(name || '').trim();
        if (!t) return false;
        for (const re of skipRes) {
            if (re.test(t)) return false;
        }
        for (const re of invRes) {
            if (re.test(t)) return true;
        }
        if (/^ППА\s/i.test(t)) return true;
        if (t.length >= minLen) return true;
        return false;
    };
}

function classifyRow(name, levelsCompiled, isLeaf) {
    if (isLeaf(name)) return 'leaf';
    for (const lvl of levelsCompiled) {
        if (lvl.id === 'group') continue;
        if (lvl.regexes.some((re) => re.test(name))) return lvl.id;
    }
    for (const lvl of levelsCompiled) {
        if (lvl.id === 'group' && lvl.regexes.some((re) => re.test(name))) return 'group';
    }
    if (
        GROUP_HINT.test(name) ||
        (name.length < 48 && !name.includes(',') && !/^ППА/i.test(name) && name.length > 2)
    ) {
        return 'group';
    }
    return 'unknown';
}

function resolveHierarchyConfig(ruleOrConfig) {
    const h = ruleOrConfig?.hierarchy || ruleOrConfig || {};
    return {
        nameColumn: ruleOrConfig?.layout?.name_column ?? ruleOrConfig?.name_column ?? 0,
        dataStartRow:
            ruleOrConfig?.layout?.data_start_row ?? ruleOrConfig?.data_start_row ?? 0,
        levels: compilePatterns(h.levels?.length ? h.levels : DEFAULT_LEVELS),
        leafRules: h.leaf_rules || {},
        skipPatterns: (ruleOrConfig?.filters?.skip_row_patterns || ['^Итого']).map(
            (p) => new RegExp(p, 'i')
        ),
    };
}

/**
 * @param {Array<Array>} data
 * @param {Object} config rule fragment or { hierarchy, layout, filters, data_start_row }
 * @param {Object} [options] { maxCol, onlyLeaves, limit }
 */
function walkHierarchy(data, config, options = {}) {
    const cfg = resolveHierarchyConfig(config);
    const isLeaf = buildLeafChecker(cfg.leafRules);
    const nameCol = cfg.nameColumn;
    const startRow = cfg.dataStartRow || 0;
    const maxCol = options.maxCol ?? 11;
    const warnings = [];
    const skipRows = new Set([
        ...(options.skipRowIndices || []),
        ...(options.styleHints?.likely_subtotal_rows || []),
    ]);
    const hiddenRows = new Set([
        ...(options.hiddenRowIndices || []),
        ...(options.styleHints?.hidden_rows || []),
    ]);

    let group = '';
    let unit = '';
    let branch = '';
    const rows = [];

    const shouldSkip = (name) => cfg.skipPatterns.some((re) => re.test(name));

    for (let i = startRow; i < data.length; i++) {
        if (skipRows.has(i) || hiddenRows.has(i)) continue;
        const row = data[i];
        const name = cellText(row, nameCol);
        if (!name || shouldSkip(name) || HEADER_SKIP.test(name)) continue;

        const hasNums = rowHasAmounts(row, 1, maxCol);
        const kind = classifyRow(name, cfg.levels, isLeaf);

        if (kind === 'leaf') {
            if (!hasNums) continue;
            const path = [group, unit, branch].filter(Boolean);
            rows.push({
                row_index: i,
                path,
                leaf_name: name,
                ancestors: { group, unit, branch },
                row,
            });
            continue;
        }

        if (kind === 'branch') {
            branch = name;
            continue;
        }

        if (kind === 'unit') {
            unit = name;
            branch = '';
            continue;
        }

        if (kind === 'group') {
            group = name;
            unit = '';
            branch = '';
            continue;
        }

        if (hasNums && isLeaf(name)) {
            const path = [group, unit, branch].filter(Boolean);
            rows.push({
                row_index: i,
                path,
                leaf_name: name,
                ancestors: { group, unit, branch },
                row,
            });
        }
    }

    if (rows.length === 0) {
        warnings.push('walkHierarchy: листовые строки не найдены');
    }

    const limited = options.limit ? rows.slice(0, options.limit) : rows;
    return { rows: limited, allRows: rows, warnings, stackState: { group, unit, branch } };
}

function rowHasAmounts(row, fromCol, toCol) {
    for (let c = fromCol; c <= toCol; c++) {
        const v = row[c];
        if (typeof v === 'number' && v !== 0) return true;
        const s = String(v ?? '')
            .replace(/\s/g, '')
            .replace(',', '.');
        if (/^-?\d/.test(s)) return true;
    }
    return false;
}

/** Значения полей иерархии из path + leaf_name */
function resolveHierarchyFields(field, path, leafName) {
    const p = path || [];
    switch (field) {
        case 'group':
            return p[0] || '';
        case 'unit':
            return p[1] || '';
        case 'parent_unit':
            return p.length >= 2 ? p[p.length - 2] : p[0] || '';
        case 'subdivision':
            return p.length ? p[p.length - 1] : '';
        case 'path':
            return p.join(' / ');
        case 'asset_name':
            return leafName || '';
        case 'year':
            return '';
        default:
            return '';
    }
}

function getDefaultOsHierarchyLevels() {
    return JSON.parse(JSON.stringify(DEFAULT_LEVELS));
}

module.exports = {
    walkHierarchy,
    resolveHierarchyFields,
    resolveHierarchyConfig,
    buildLeafChecker,
    classifyRow,
    getDefaultOsHierarchyLevels,
    GROUP_HINT,
    DEFAULT_LEVELS,
};
