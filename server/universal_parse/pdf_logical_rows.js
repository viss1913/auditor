const { scoreDataRow } = require('./pdf_row_scoring');

const HEADER_HINT_RE =
    /^(№|no\.?|#)\s|isin|тикер|кол|цена|сумма|наименование|маршрут|отправитель|получатель|итого/i;

/**
 * Физические строки (tight yTol) → логические с merge continuation.
 * @param {Array<{ index?: number, y?: number, page?: number, text?: string, items?: object[] }>} physicalLines
 * @param {object} [opts]
 */
function mergeContinuationLines(physicalLines = [], opts = {}) {
    const yGapMin = opts.yGapMin ?? 3;
    const yGapMax = opts.yGapMax ?? 16;
    const minItemsRatio = opts.minItemsRatio ?? 0.45;

    if (!physicalLines.length) return [];

    const logical = [];

    for (const line of physicalLines) {
        const prev = logical[logical.length - 1];
        if (prev && isContinuationLine(prev, line, { yGapMin, yGapMax, minItemsRatio })) {
            const mergedItems = [...(prev.items || []), ...(line.items || [])].sort(
                (a, b) => (a.x0 ?? a.x ?? 0) - (b.x0 ?? b.x ?? 0)
            );
            prev.items = mergedItems;
            prev.text = mergedItems.map((w) => w.text).join(' ').trim() || prev.text;
            prev.continuation = true;
            prev.merged_from = [...(prev.merged_from || [prev.index]), line.index];
            prev.y = Math.max(prev.y ?? 0, line.y ?? 0);
            continue;
        }

        logical.push({
            ...line,
            logical_index: logical.length,
            continuation: false,
            merged_from: [line.index],
        });
    }

    return logical.map((row, logical_index) => ({ ...row, logical_index }));
}

function isContinuationLine(prev, next, { yGapMin, yGapMax, minItemsRatio }) {
    if (prev.page != null && next.page != null && prev.page !== next.page) return false;

    const prevText = String(prev.text || '').trim();
    const nextText = String(next.text || '').trim();
    if (!prevText || !nextText) return false;
    if (HEADER_HINT_RE.test(nextText) && !HEADER_HINT_RE.test(prevText)) return false;
    if (/^итого\b/i.test(nextText) || /^итого\b/i.test(prevText)) return false;

    const gap = Math.abs((prev.y ?? 0) - (next.y ?? 0));
    if (gap < yGapMin || gap > yGapMax) return false;

    const prevItems = prev.items || [];
    const nextItems = next.items || [];
    if (!prevItems.length || !nextItems.length) return false;

    if (nextItems.length >= prevItems.length) return false;
    if (nextItems.length / prevItems.length > minItemsRatio + 0.35) return false;

    const prevScore = scoreDataRow(prev);
    const nextScore = scoreDataRow(next);
    if (prevScore >= 0.35 && nextScore >= 0.35) return false;

    const prevLeft = Math.min(...prevItems.map((it) => it.x0 ?? it.x ?? 0));
    const nextLeft = Math.min(...nextItems.map((it) => it.x0 ?? it.x ?? 0));
    const prevRight = Math.max(
        ...prevItems.map((it) => (it.x1 ?? (it.x0 ?? it.x ?? 0) + (it.w || 0)))
    );

    if (nextLeft > prevRight + 8) return false;
    if (nextLeft < prevLeft - 24) return false;

    const nextLooksWrapped =
        nextItems.length <= Math.max(1, Math.floor(prevItems.length * minItemsRatio)) ||
        nextText.length < prevText.length * 0.65;
    return nextLooksWrapped;
}

/**
 * Двухуровневый pipeline: items → physical cluster → logical merge.
 */
function buildLogicalRowsFromItems(items, clusterRowsFn, opts = {}) {
    const physical = clusterRowsFn(items, opts.physicalYTol ?? 4);
    const physicalLines = physical.map((row, index) => ({
        index,
        page: row.page,
        y: row.y,
        text: row.text,
        items: (row.items || []).map((it) => ({
            text: it.text,
            x: it.x,
            x0: it.x,
            x1: it.x + (it.w || 0),
            y0: it.y,
            w: it.w,
            h: it.h,
        })),
    }));
    return {
        physical_lines: physicalLines,
        logical_rows: mergeContinuationLines(physicalLines, opts),
    };
}

module.exports = {
    mergeContinuationLines,
    isContinuationLine,
    buildLogicalRowsFromItems,
};
