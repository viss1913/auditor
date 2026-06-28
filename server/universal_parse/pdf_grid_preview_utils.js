const TABLE_HEADER_RE = /^(№|no\.?|#)\s|isin|тикер|кол|цена|сумма|вал|дата|qty|price|amount|наименование|маршрут|отправитель|получатель|ндс/i;
const DATA_ROW_RE = /^(\d+[\s,.]|[A-Z]{2}\d{10})/i;
const { suggestDataStartByScoring } = require('./pdf_row_scoring');

/**
 * Эвристика: индекс первой строки данных на странице (page-level clustered row index).
 * @param {Array<{ text?: string }>} clusteredRows
 */
function suggestDataStartRow(clusteredRows = []) {
    if (!clusteredRows.length) return 0;

    const scored = suggestDataStartByScoring(clusteredRows);
    if (scored > 0) return scored;

    for (let i = 0; i < clusteredRows.length; i++) {
        const text = String(clusteredRows[i]?.text || '').trim();
        if (!text) continue;
        const tokens = text.split(/\s+/).filter(Boolean);
        const numericTokens = tokens.filter((t) => /^-?\d[\d\s,.]*$/.test(t)).length;
        if (DATA_ROW_RE.test(text) && numericTokens >= 2) return i;
    }

    for (let i = 0; i < clusteredRows.length - 1; i++) {
        const text = String(clusteredRows[i]?.text || '').trim();
        if (TABLE_HEADER_RE.test(text) && (/\bisin\b/i.test(text) || /наименование|маршрут|кол-?во/i.test(text))) {
            return i + 1;
        }
    }

    for (let i = 0; i < clusteredRows.length; i++) {
        const text = String(clusteredRows[i]?.text || '').trim();
        const tokens = text.split(/\s+/).filter(Boolean);
        if (tokens.filter((t) => /^-?\d[\d\s,.]*$/.test(t)).length >= 3) return i;
    }

    return Math.min(1, clusteredRows.length - 1);
}

/**
 * Page-level data start → dataStart внутри extractTableFromRows (regionRows = slice.slice(1)).
 */
function pageDataStartToGridDataStart(pageDataStart, sectionStartIdx = 0) {
    const n = parseInt(pageDataStart, 10);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.max(0, n - sectionStartIdx - 1);
}

/**
 * @param {Array<{ text?: string, y?: number, page?: number }>} rows
 * @param {number} pageWidthPt
 * @param {number} pageHeightPt
 */
function clusteredRowsForPreview(rows, pageWidthPt, pageHeightPt) {
    const pageW = Number(pageWidthPt) || 595.28;
    const pageH = Number(pageHeightPt) || 841.89;
    const suggested = suggestDataStartRow(rows);

    return rows.map((row, index) => ({
        index,
        text: String(row.text || '').trim(),
        yNorm: row.y != null ? row.y / pageH : null,
        isHeaderCandidate: index < suggested,
    }));
}

function inferColumnCentersFromPageRows(rows, suggestedDataStart) {
    if (!rows?.length) return [];
    const dataStart =
        Number.isFinite(suggestedDataStart) && suggestedDataStart >= 0
            ? suggestedDataStart
            : suggestDataStartRow(rows);
    const hdrIdx =
        dataStart > 0
            ? dataStart - 1
            : rows.findIndex((row) => {
                  const text = String(row?.text || '');
                  return /наименование|маршрут|кол-?во|isin|qty|price|amount/i.test(text);
              });
    if (hdrIdx < 0) return [];
    const items = rows[hdrIdx]?.items || [];
    if (items.length < 2) return [];
    return [...items].sort((a, b) => a.x - b.x).map((it) => it.x);
}

/**
 * Границы между колонками (midpoint) для overlay редактора.
 */
function inferColumnBoundaryNorms(rows, suggestedDataStart, pageWidthPt) {
    const lefts = inferColumnCentersFromPageRows(rows, suggestedDataStart);
    const pageW = Number(pageWidthPt) || 595.28;
    if (lefts.length < 2) return lefts.map((x) => x / pageW);
    const bounds = [lefts[0] * 0.5];
    for (let i = 1; i < lefts.length; i++) {
        bounds.push((lefts[i - 1] + lefts[i]) / 2);
    }
    bounds.push(lefts[lefts.length - 1] + (pageW - lefts[lefts.length - 1]) * 0.15);
    return bounds.map((x) => Math.max(0.01, Math.min(0.99, x / pageW)));
}

module.exports = {
    suggestDataStartRow,
    pageDataStartToGridDataStart,
    clusteredRowsForPreview,
    inferColumnCentersFromPageRows,
    inferColumnBoundaryNorms,
};
