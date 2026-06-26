/**
 * Сравнение grid и line-based extract для брокерских PDF.
 */
const { extractPdfTablesFromLines } = require('./pdf_table_extract');
const { headerOverlap } = require('../pdf_parse_validation_report');

/**
 * @param {string[]} lines
 * @param {{ headers?: string[], rows?: object[] }} gridResult
 */
function comparePdfDualExtract(lines, gridResult) {
    const lineResult = extractPdfTablesFromLines(lines || []);
    if (!lineResult.ok || !gridResult?.headers?.length) {
        return {
            ok: false,
            headerOverlap: 0,
            lineRowCount: lineResult.rows?.length || 0,
            gridRowCount: gridResult?.rows?.length || 0,
            headers: lineResult.headers || [],
            note: 'Один из extractors не дал таблицу',
        };
    }

    const overlap = headerOverlap(gridResult.headers, lineResult.headers);
    const gridRows = gridResult.rows?.length || 0;
    const lineRows = lineResult.rows?.length || 0;
    const rowRatio = gridRows && lineRows ? Math.min(gridRows, lineRows) / Math.max(gridRows, lineRows) : 0;

    let note = '';
    if (overlap < 0.5) note = 'Заголовки grid и line сильно расходятся';
    else if (rowRatio < 0.4) note = `Строк grid=${gridRows}, line=${lineRows}`;

    return {
        ok: true,
        headerOverlap: overlap,
        rowCountRatio: rowRatio,
        lineRowCount: lineRows,
        gridRowCount: gridRows,
        headers: lineResult.headers,
        method: lineResult.method,
        note,
    };
}

module.exports = { comparePdfDualExtract };
