const xlsx = require('xlsx');
const { pickPreferredSheet } = require('./excel_sheet_meta');

/**
 * @param {Buffer} buffer
 * @returns {{ sheetNames: string[], defaultSheet: string|null }}
 */
function listSheetNames(buffer) {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames || [];
    const defaultSheet = pickPreferredSheet(sheetNames);
    return { sheetNames, defaultSheet };
}

/**
 * @param {Buffer} buffer
 * @param {string} [sheetName]
 * @param {number} [maxRows]
 */
function analyzeExcelBuffer(buffer, sheetName, maxRows = 30) {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetNames = workbook.SheetNames;
    const usedSheet =
        sheetName && sheetNames.includes(sheetName)
            ? sheetName
            : sheetNames.find((s) => /исходн/i.test(s)) || sheetNames[0];

    const worksheet = workbook.Sheets[usedSheet];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const previewRows = data.slice(0, maxRows);
    const previewText = previewRows.map((row) => row.join('\t')).join('\n');

    let suggestedParserType = null;
    let suggestedVariant = null;

    const allNames = sheetNames.join(' ').toLowerCase();
    if (/исходная выгрузка 01|амортизац/i.test(allNames)) {
        suggestedParserType = 'osv';
        suggestedVariant = '01_flat';
    } else if (/исходная выгрузка 08|оборотно-сальдов/i.test(allNames)) {
        suggestedParserType = 'osv';
        suggestedVariant = '08_osv';
    } else if (data.some((row) => /^\d{2}\.\d{2}\.\d{4}/.test(String(row[0] || '')))) {
        suggestedParserType = 'uk';
    }

    return {
        sheetNames,
        sheetName: usedSheet,
        previewText,
        rowCount: data.length,
        suggestedParserType,
        suggestedVariant,
    };
}

module.exports = { analyzeExcelBuffer, listSheetNames };
