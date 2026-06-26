const { walkHierarchy, buildLeafChecker } = require('./hierarchy_walker');
const { getTreeProfile } = require('./tree_profiles');
const { normalizeLabel } = require('./excel_sheet_meta');

function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function cellText(row, col) {
    if (!row) return '';
    return normalizeLabel(row[col]).text;
}

function compileLevelPatterns(levels) {
    return (levels || []).map((lvl) => ({
        ...lvl,
        regexes: (lvl.patterns || []).map((p) => {
            try {
                return new RegExp(p, 'i');
            } catch {
                return null;
            }
        }).filter(Boolean),
    }));
}

const SKIP_LABEL =
    /^(Группа учета|Подразделение$|Основное средство|Выводимые данные|Ведомость|Итого)$/i;
const HEADER_SKIP =
    /^Счет,?\s*Наименование|^Счёт,?\s*Наименование|^Сальдо\s+на\s+|^Карточка\s+счета|^Договоры?$|^Контрагенты?$/i;

function classifyByLevels(label, levelsCompiled) {
    const t = String(label || '').trim();
    if (!t) return { kind: 'skip', levelId: null };
    if (SKIP_LABEL.test(t) || HEADER_SKIP.test(t)) return { kind: 'skip', levelId: null };
    if (/^(ОАО|ООО|АО|ПАО|ЗАО)(\s|$)/i.test(t)) return { kind: 'entity', levelId: null };
    if (/Обороты\s+за\s+\d{4}/i.test(t)) return { kind: 'period', levelId: null };

    for (const lvl of levelsCompiled) {
        if (lvl.regexes.some((re) => re.test(t))) {
            return { kind: 'level', levelId: lvl.id };
        }
    }
    return { kind: 'other', levelId: null };
}

function hasOsvTurnover(row) {
    for (let c = 1; c <= 6; c++) {
        const n = toNum(row[c]);
        if (n !== null && n !== 0) return true;
    }
    return false;
}

function osvTurnoverSignature(row) {
    return [1, 2, 3, 4, 5, 6].map((c) => toNum(row[c])).join('|');
}

/** ОП-строка с теми же оборотами, что и следующий объект/период — дубль, не выводим. */
function shouldSkipSubdivisionSubtotal(data, rowIndex, row, nameCol, levelsCompiled) {
    const sig = osvTurnoverSignature(row);
    for (let j = rowIndex + 1; j < Math.min(data.length, rowIndex + 12); j++) {
        const label = cellText(data[j], nameCol);
        if (!label) continue;
        const { kind, levelId } = classifyByLevels(label, levelsCompiled);
        if (kind === 'skip') continue;
        if (kind === 'level' && (levelId === 'subdivision' || levelId === 'account')) break;
        if ((kind === 'other' || kind === 'period') && hasOsvTurnover(data[j])) {
            return osvTurnoverSignature(data[j]) === sig;
        }
        break;
    }
    return false;
}

function stackToPath(stack, levelOrder) {
    return levelOrder.map((id) => stack[id]).filter(Boolean);
}

function stackToAncestors(stack, levelOrder) {
    const out = {};
    for (const id of levelOrder) {
        if (stack[id]) out[id] = stack[id];
    }
    return out;
}

function resolveStackField(field, stack, levelOrder, leafName) {
    const path = stackToPath(stack, levelOrder);
    switch (field) {
        case 'group':
            return stack.group || path[0] || '';
        case 'unit':
            return stack.unit || path[1] || '';
        case 'parent_unit':
            return path.length >= 2 ? path[path.length - 2] : path[0] || '';
        case 'subdivision':
            return stack.subdivision || stack.branch || path[path.length - 1] || '';
        case 'account':
            return stack.account || '';
        case 'counterparty':
            return stack.counterparty || '';
        case 'contract':
            return stack.contract || '';
        case 'path':
            return path.join(' / ');
        case 'asset_name':
        case 'object_name':
            return leafName || '';
        default:
            if (stack[field]) return stack[field];
            return '';
    }
}

function buildOsvMetricRow(stack, levelOrder, row, targets = {}) {
    const out = { ...targets };
    for (const id of levelOrder) {
        const lvl = (targets._levels || []).find((l) => l.id === id);
        if (lvl?.target) out[lvl.target] = stack[id] || '';
    }
    delete out._levels;
    out['Сальдо Дт начало'] = toNum(row[1]);
    out['Сальдо Кт начало'] = toNum(row[2]);
    out['Оборот Дт'] = toNum(row[3]);
    out['Оборот Кт'] = toNum(row[4]);
    out['Сальдо Дт конец'] = toNum(row[5]);
    out['Сальдо Кт конец'] = toNum(row[6]);
    return out;
}

function emitLevelRow({
    i,
    label,
    row,
    stack,
    levelOrder,
    levels,
    entity,
    results,
    treeSample,
    sampleLimit,
    rowKind = 'leaf',
}) {
    const path = stackToPath(stack, levelOrder);
    const ancestors = stackToAncestors(stack, levelOrder);
    if (treeSample.length < sampleLimit && rowKind === 'leaf') {
        treeSample.push({
            row_index: i,
            path,
            leaf_name: label,
            ancestors,
        });
    }
    const targets = { _levels: levels, _row_kind: rowKind };
    for (const lvl of levels) {
        targets[lvl.target] = stack[lvl.id] || '';
    }
    if (entity) targets['Юрлицо'] = entity;
    results.push(buildOsvMetricRow(stack, levelOrder, row, targets));
}

function emitLeafRow(args) {
    emitLevelRow({ ...args, rowKind: 'leaf' });
}

function walkLevelsStack(data, rule, options = {}) {
    const hierarchy = rule.hierarchy || {};
    const levels = hierarchy.levels || [];
    const levelsCompiled = compileLevelPatterns(levels);
    const levelOrder = levels.map((l) => l.id);
    const leaf = hierarchy.leaf || { kind: 'level_id', level_id: 'contract' };
    const emitAggregateRows = Boolean(
        options.emitAggregateRows ?? hierarchy.emit_aggregate_rows
    );
    const emitAggregateLevelIds = hierarchy.emit_aggregate_level_ids || [];
    const nameCol = rule.layout?.name_column ?? 0;
    const startRow = rule.layout?.data_start_row ?? 0;
    const rowOutlineLevels = options.rowOutlineLevels || [];
    const skipRows = new Set([
        ...(options.skipRowIndices || []),
        ...(options.styleHints?.likely_subtotal_rows || []),
    ]);
    const hiddenRows = new Set([
        ...(options.hiddenRowIndices || []),
        ...(options.styleHints?.hidden_rows || []),
    ]);

    const stack = {};
    for (const id of levelOrder) stack[id] = '';
    let entity = '';
    let pendingObject = '';
    for (const row of data.slice(0, 10)) {
        const t = cellText(row, nameCol);
        if (/^(ОАО|ООО|АО|ПАО|ЗАО)(\s|$)/i.test(t) && t.length <= 120) {
            entity = entity || t;
        }
    }

    const results = [];
    const treeSample = [];
    const warnings = [];
    const sampleLimit = options.treeSampleLimit ?? 8;

    for (let i = startRow; i < data.length; i++) {
        if (skipRows.has(i)) continue;
        if (hiddenRows.has(i)) continue;

        const row = data[i];
        const { text: label, indentDepth } = normalizeLabel(row?.[nameCol]);
        if (!label) continue;

        const outlineLvl = rowOutlineLevels[i] || 0;
        const depth = outlineLvl > 0 ? outlineLvl : indentDepth;
        const { kind, levelId } = classifyByLevels(label, levelsCompiled);
        if (kind === 'skip') continue;

        const nextLabel = cellText(data[i + 1], nameCol);
        const nextIsPeriod = /Обороты\s+за\s+\d{4}/i.test(nextLabel);
        const hasNums = hasOsvTurnover(row);

        if (kind === 'entity') {
            entity = label;
            continue;
        }

        if (kind === 'level' && levelId) {
            stack[levelId] = label;
            const idx = levelOrder.indexOf(levelId);
            for (let j = idx + 1; j < levelOrder.length; j++) stack[levelOrder[j]] = '';

            // Группировка Excel: при подъёме на уровень выше сбрасываем «младшие» поля стека
            if (outlineLvl > 0 && depth > 0) {
                for (let j = idx + 1; j < levelOrder.length; j++) {
                    stack[levelOrder[j]] = '';
                }
            }

            pendingObject = '';

            const isLeafLevel =
                (leaf.kind === 'level_id' && leaf.level_id === levelId) ||
                (leaf.kind === 'pattern' && leaf.level_id === levelId);

            if (isLeafLevel) {
                emitLeafRow({
                    i,
                    label,
                    row,
                    stack,
                    levelOrder,
                    levels,
                    entity,
                    results,
                    treeSample,
                    sampleLimit,
                });
            } else if (
                emitAggregateRows &&
                hasNums &&
                (!emitAggregateLevelIds.length || emitAggregateLevelIds.includes(levelId)) &&
                !(
                    levelId === 'subdivision' &&
                    shouldSkipSubdivisionSubtotal(data, i, row, nameCol, levelsCompiled)
                )
            ) {
                emitLevelRow({
                    i,
                    label,
                    row,
                    stack,
                    levelOrder,
                    levels,
                    entity,
                    results,
                    treeSample,
                    sampleLimit,
                    rowKind: 'aggregate',
                });
            }
            continue;
        }

        if (kind === 'period' && pendingObject) {
            const path = stackToPath(stack, levelOrder);
            const targets = {};
            for (const lvl of levels) targets[lvl.target] = stack[lvl.id] || '';
            targets['Объект'] = pendingObject;
            if (entity) targets['Юрлицо'] = entity;
            const y = label.match(/(\d{4})/);
            targets['Период'] = label;
            targets['Год'] = y ? y[1] : '';
            Object.assign(targets, {
                'Сальдо Дт начало': toNum(row[1]),
                'Сальдо Кт начало': toNum(row[2]),
                'Оборот Дт': toNum(row[3]),
                'Оборот Кт': toNum(row[4]),
                'Сальдо Дт конец': toNum(row[5]),
                'Сальдо Кт конец': toNum(row[6]),
            });
            results.push(targets);
            if (treeSample.length < sampleLimit) {
                treeSample.push({ row_index: i, path, leaf_name: pendingObject, ancestors: stackToAncestors(stack, levelOrder) });
            }
            pendingObject = '';
            continue;
        }

        if (leaf.kind === 'os_08_object' && kind === 'other') {
            if (!hasNums && label.length > 3) {
                pendingObject = label;
                continue;
            }
            if (hasNums && nextIsPeriod) {
                pendingObject = label;
                continue;
            }
            if (hasNums) {
                const path = stackToPath(stack, levelOrder);
                const targets = {};
                for (const lvl of levels) targets[lvl.target] = stack[lvl.id] || '';
                targets['Объект'] = label;
                if (entity) targets['Юрлицо'] = entity;
                Object.assign(targets, {
                    'Сальдо Дт начало': toNum(row[1]),
                    'Сальдо Кт начало': toNum(row[2]),
                    'Оборот Дт': toNum(row[3]),
                    'Оборот Кт': toNum(row[4]),
                    'Сальдо Дт конец': toNum(row[5]),
                    'Сальдо Кт конец': toNum(row[6]),
                });
                results.push(targets);
                if (treeSample.length < sampleLimit) {
                    treeSample.push({ row_index: i, path, leaf_name: label, ancestors: stackToAncestors(stack, levelOrder) });
                }
                pendingObject = '';
            }
        }
    }

    if (results.length === 0) {
        warnings.push('tree_walker: листовые строки не найдены по hierarchy.levels');
    }

    return { rows: results, treeSample, warnings, mode: 'levels_stack' };
}

/**
 * Унифицированный обход: hierarchy_rows → walkHierarchy; hierarchy_osv → levels stack.
 */
function walkTree(data, rule, options = {}) {
    const layoutType = rule.layout?.layout_type;
    if (layoutType === 'hierarchy_osv' || (rule.hierarchy?.levels?.length && layoutType !== 'hierarchy_rows')) {
        return walkLevelsStack(data, rule, options);
    }

    const maxCol = options.maxCol ?? 11;
    const { rows: leafRows, warnings } = walkHierarchy(data, rule, { maxCol, limit: options.rowLimit });
    const treeSample = leafRows.map((r) => ({
        row_index: r.row_index,
        path: r.path || [],
        leaf_name: r.leaf_name,
        ancestors: r.ancestors || {},
    }));

    return {
        rows: leafRows,
        treeSample,
        warnings,
        mode: 'path_walk',
        leafRows,
    };
}

function flattenLeafRowsToTable(leafRows, rule, context = {}) {
    const { entity = '', year = '' } = context;
    const plan = context.plan || [];
    const results = [];

    for (const leaf of leafRows) {
        const rowObj = {};
        for (const p of plan) {
            if (p.kind === 'entity') rowObj[p.target] = entity;
            else if (p.kind === 'group') rowObj[p.target] = resolveStackField('group', leaf.ancestors || {}, ['group', 'unit', 'branch'], leaf.leaf_name);
            else if (p.kind === 'subdivision')
                rowObj[p.target] = leaf.ancestors?.branch || resolveStackField('subdivision', {}, [], leaf.leaf_name);
            else if (p.kind === 'hierarchy')
                rowObj[p.target] = resolveStackField(p.field, leaf.ancestors || {}, ['group', 'unit', 'branch'], leaf.leaf_name);
            else if (p.kind === 'asset') rowObj[p.target] = leaf.leaf_name;
            else if (p.kind === 'year') rowObj[p.target] = year;
            else if (p.kind === 'metric') rowObj[p.target] = toNum(leaf.row[p.col]);
            else if (p.kind === 'account') rowObj[p.target] = leaf.ancestors?.account || '';
            else if (p.kind === 'counterparty') rowObj[p.target] = leaf.ancestors?.counterparty || '';
            else if (p.kind === 'contract') rowObj[p.target] = leaf.leaf_name || '';
        }
        results.push(rowObj);
    }
    return results;
}

module.exports = {
    walkTree,
    walkLevelsStack,
    classifyByLevels,
    compileLevelPatterns,
    resolveStackField,
    stackToPath,
    flattenLeafRowsToTable,
    cellText,
    toNum,
};
