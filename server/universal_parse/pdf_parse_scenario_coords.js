/**
 * Нормализация X-координат колонок PDF (доля ширины страницы).
 */

function defaultPageWidthPt(pageWidthPt) {
    const w = Number(pageWidthPt);
    return Number.isFinite(w) && w > 0 ? w : 595.28;
}

function centersToNorm(columnCenters, pageWidthPt) {
    const w = defaultPageWidthPt(pageWidthPt);
    return (columnCenters || []).map((x) => Number(x) / w);
}

function centersFromNorm(centerNorms, pageWidthPt) {
    const w = defaultPageWidthPt(pageWidthPt);
    return (centerNorms || []).map((n) => Number(n) * w);
}

function xTolFromNorm(xTolNorm, pageWidthPt) {
    const w = defaultPageWidthPt(pageWidthPt);
    const n = Number(xTolNorm);
    if (Number.isFinite(n) && n > 0 && n <= 1) return n * w;
    return Number(xTolNorm) || 40;
}

function xTolToNorm(xTol, pageWidthPt) {
    const w = defaultPageWidthPt(pageWidthPt);
    return Number(xTol) / w;
}

/**
 * @param {string[]} headers
 * @param {number[]} columnCenters
 * @param {number} pageWidthPt
 * @param {number} [xTol]
 */
function buildColumnsFromExtract(headers, columnCenters, pageWidthPt, xTol) {
    const norms = centersToNorm(columnCenters, pageWidthPt);
    const w = defaultPageWidthPt(pageWidthPt);
    return (headers || []).map((label, index) => {
        const target = String(label || `col_${index + 1}`)
            .trim()
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 64) || `col_${index + 1}`;
        return {
            index,
            target,
            label: String(label || `col_${index + 1}`).trim(),
            description: '',
            center_norm: norms[index] ?? norms[norms.length - 1] ?? 0,
            type: 'text',
        };
    });
}

/**
 * @param {object} rule PdfParseScenario v3
 * @param {number} [pageWidthPt]
 */
function extractLayoutFromScenario(rule, pageWidthPt) {
    const w = defaultPageWidthPt(pageWidthPt || rule?.layout?.page_width_pt);
    const cols = [...(rule?.columns || [])].sort((a, b) => a.index - b.index);
    return {
        columnCenters: centersFromNorm(
            cols.map((c) => c.center_norm),
            w
        ),
        headers: cols.map((c) => c.label || c.target),
        xTol: xTolFromNorm(rule?.layout?.x_tol_norm, w),
        dataStart: rule?.layout?.data_start_row ?? undefined,
        headerRowCount: rule?.layout?.header_row_count ?? undefined,
        pageWidthPt: w,
    };
}

module.exports = {
    defaultPageWidthPt,
    centersToNorm,
    centersFromNorm,
    xTolFromNorm,
    xTolToNorm,
    buildColumnsFromExtract,
    extractLayoutFromScenario,
};
