const { resolveColumnHint } = require('./result_table_commands');
const { sanitizeFilterPlan, rowMatchesFilters, formatFilterSummary } = require('./table_row_filter');

const ALLOWED_OPS = new Set(['sum', 'count', 'count_non_empty', 'min', 'max', 'avg']);
const DEFAULT_GROUP_LIMIT = 25;

function parseNumericCell(raw) {
    const s = String(raw ?? '')
        .trim()
        .replace(/\s/g, '')
        .replace(',', '.');
    if (!s || s === '-') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function isNonEmptyCell(raw) {
    return String(raw ?? '').trim() !== '';
}

function formatRuNumber(n) {
    if (!Number.isFinite(n)) return '';
    const fixed = Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',');
    return fixed.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function sanitizeTableQueryPlan(raw, headers = []) {
    const action = String(raw?.action || '').trim() === 'aggregate' ? 'aggregate' : null;
    if (!action) return { ok: false, errors: ['Неизвестное действие'] };

    const op = ALLOWED_OPS.has(String(raw?.op || '').trim()) ? String(raw.op).trim() : null;
    if (!op) return { ok: false, errors: ['Нужна операция: sum, count, count_non_empty, min, max, avg'] };

    let column = String(raw?.column || '').trim();
    if (column && headers.length) {
        column = resolveColumnHint(column, headers) || column;
    }
    if (op !== 'count' && (!column || !headers.includes(column))) {
        return { ok: false, errors: [`Колонка не найдена: ${raw?.column || '—'}`] };
    }

    let groupBy = String(raw?.groupBy || raw?.group_by || '').trim();
    if (groupBy && headers.length) {
        groupBy = resolveColumnHint(groupBy, headers) || groupBy;
    }
    if (groupBy && !headers.includes(groupBy)) {
        return { ok: false, errors: [`Колонка groupBy не найдена: ${raw?.groupBy || '—'}`] };
    }

    const filterPlan = sanitizeFilterPlan(
        {
            mode: raw?.mode || 'keep',
            combine: raw?.combine,
            filters: raw?.filters,
        },
        headers
    );

    const limit = Math.min(Math.max(parseInt(raw?.limit, 10) || DEFAULT_GROUP_LIMIT, 1), 100);

    return {
        ok: true,
        plan: {
            action: 'aggregate',
            op,
            column: op === 'count' ? column || null : column,
            groupBy: groupBy || null,
            filters: filterPlan.filters,
            filterMode: filterPlan.mode,
            filterCombine: filterPlan.combine,
            limit,
        },
    };
}

function createAccumulator(op) {
    if (op === 'count') return { count: 0 };
    if (op === 'count_non_empty') return { count: 0 };
    if (op === 'sum') return { sum: 0, count: 0 };
    if (op === 'avg') return { sum: 0, count: 0 };
    if (op === 'min') return { value: null };
    if (op === 'max') return { value: null };
    return { count: 0 };
}

function feedAccumulator(acc, op, rawValue) {
    if (op === 'count') {
        acc.count += 1;
        return;
    }
    if (op === 'count_non_empty') {
        if (isNonEmptyCell(rawValue)) acc.count += 1;
        return;
    }
    const n = parseNumericCell(rawValue);
    if (n == null) return;
    if (op === 'sum' || op === 'avg') {
        acc.sum += n;
        acc.count += 1;
    } else if (op === 'min') {
        if (acc.value == null || n < acc.value) acc.value = n;
    } else if (op === 'max') {
        if (acc.value == null || n > acc.value) acc.value = n;
    }
}

function finalizeAccumulator(acc, op) {
    if (op === 'count' || op === 'count_non_empty') return acc.count;
    if (op === 'sum') return acc.count ? acc.sum : null;
    if (op === 'avg') return acc.count ? acc.sum / acc.count : null;
    if (op === 'min' || op === 'max') return acc.value;
    return null;
}

function rowPassesFilters(row, plan) {
    if (!plan.filters?.length) return true;
    const match = rowMatchesFilters(row, { filters: plan.filters, combine: plan.filterCombine });
    return plan.filterMode === 'keep' ? match : !match;
}

function buildFilterSummary(plan) {
    if (!plan.filters?.length) return null;
    return formatFilterSummary({
        mode: plan.filterMode,
        filters: plan.filters,
        combine: plan.filterCombine,
    });
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {object} plan sanitized plan
 */
function executeTableQueryOnRows(rows, plan) {
    const totalRows = rows.length;
    const filtered = rows.filter((row) => rowPassesFilters(row, plan));
    const matchedRows = filtered.length;

    if (plan.groupBy) {
        const buckets = new Map();
        for (const row of filtered) {
            const key = String(row[plan.groupBy] ?? '').trim() || '(пусто)';
            if (!buckets.has(key)) buckets.set(key, createAccumulator(plan.op));
            if (plan.op === 'count') {
                feedAccumulator(buckets.get(key), plan.op, null);
            } else if (plan.op === 'count_non_empty') {
                feedAccumulator(buckets.get(key), plan.op, row[plan.column]);
            } else {
                feedAccumulator(buckets.get(key), plan.op, row[plan.column]);
            }
        }

        const groups = [...buckets.entries()]
            .map(([key, acc]) => ({
                key,
                value: finalizeAccumulator(acc, plan.op),
                count: acc.count ?? (plan.op === 'count' ? acc.count : undefined),
            }))
            .sort((a, b) => {
                const av = a.value ?? -Infinity;
                const bv = b.value ?? -Infinity;
                return bv - av;
            })
            .slice(0, plan.limit);

        return {
            ok: true,
            op: plan.op,
            column: plan.column,
            groupBy: plan.groupBy,
            totalRows,
            matchedRows,
            nonEmpty: null,
            value: null,
            groups,
            formattedValue: null,
            filterSummary: buildFilterSummary(plan),
        };
    }

    const acc = createAccumulator(plan.op);
    let nonEmpty = 0;
    for (const row of filtered) {
        if (plan.op === 'count') {
            feedAccumulator(acc, plan.op, null);
        } else if (plan.op === 'count_non_empty') {
            if (isNonEmptyCell(row[plan.column])) nonEmpty += 1;
            feedAccumulator(acc, plan.op, row[plan.column]);
        } else {
            if (isNonEmptyCell(row[plan.column])) nonEmpty += 1;
            feedAccumulator(acc, plan.op, row[plan.column]);
        }
    }

    const value = finalizeAccumulator(acc, plan.op);
    return {
        ok: true,
        op: plan.op,
        column: plan.column,
        groupBy: null,
        totalRows,
        matchedRows,
        nonEmpty: plan.op === 'count_non_empty' ? value : nonEmpty,
        value,
        groups: null,
        formattedValue: value == null ? null : formatRuNumber(value),
        filterSummary: buildFilterSummary(plan),
    };
}

async function executeTableQuery(snapshotStore, snapshotId, plan) {
    const snap = await snapshotStore.getSnapshot(snapshotId);
    if (!snap) return { ok: false, errors: ['Snapshot не найден'] };

    const rows = [];
    await snapshotStore.fetchAllRowsBatched(snapshotId, 500, async (batch) => {
        for (const { data } of batch) rows.push({ ...data });
    });

    return executeTableQueryOnRows(rows, plan);
}

const OP_LABELS = {
    sum: 'Сумма',
    count: 'Количество строк',
    count_non_empty: 'Непустых значений',
    min: 'Минимум',
    max: 'Максимум',
    avg: 'Среднее',
};

function formatFilterNote(result) {
    if (!result.filterSummary) return '';
    const scope =
        result.matchedRows != null && result.totalRows != null
            ? ` (${result.matchedRows} из ${result.totalRows} строк)`
            : '';
    return ` Условие: ${result.filterSummary}${scope}.`;
}

function formatQueryResultMessage(result) {
    if (!result?.ok) return null;
    const label = OP_LABELS[result.op] || result.op;
    const col = result.column ? ` по колонке **${result.column}**` : '';
    const filterNote = formatFilterNote(result);

    if (result.groups?.length) {
        const lines = result.groups
            .slice(0, 10)
            .map((g) => {
                const v = g.value == null ? '—' : formatRuNumber(g.value);
                return `• **${g.key}**: ${v}`;
            })
            .join('\n');
        const more =
            result.groups.length > 10 ? `\n…и ещё ${result.groups.length - 10} групп` : '';
        const filterPrefix = result.filterSummary ? `${filterNote}\n\n` : '';
        return (
            `${filterPrefix}**${label}**${col}, группировка по **${result.groupBy}** ` +
            `(строк после фильтра: ${result.matchedRows} из ${result.totalRows}):\n\n${lines}${more}`
        );
    }

    const val = result.formattedValue ?? (result.value == null ? '—' : String(result.value));
    if (result.op === 'count') {
        return `**${label}**${col}: **${val}** (всего в таблице ${result.totalRows}, после фильтра ${result.matchedRows}).${filterNote}`;
    }
    if (result.op === 'count_non_empty') {
        return `**${label}**${col}: **${val}** (из ${result.matchedRows} строк после фильтра).${filterNote}`;
    }
    const nonEmptyNote =
        result.nonEmpty != null
            ? ` Заполнено в **${result.nonEmpty}** из **${result.matchedRows}** строк.`
            : '';
    return `**${label}**${col}: **${val}**.${nonEmptyNote}${filterNote}`;
}

function formatQueryResultForLlm(result) {
    if (!result?.ok) return '';
    return `Результат расчёта на сервере (используй ТОЛЬКО эти цифры, не пересчитывай):\n${JSON.stringify(result, null, 2)}`;
}

module.exports = {
    ALLOWED_OPS,
    parseNumericCell,
    formatRuNumber,
    sanitizeTableQueryPlan,
    executeTableQueryOnRows,
    executeTableQuery,
    formatQueryResultMessage,
    formatQueryResultForLlm,
};
