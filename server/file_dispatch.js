const path = require('path');

function detectSourceKind(fileName) {
    const ext = path.extname(String(fileName || '')).toLowerCase();
    if (['.txt', '.csv', '.tsv'].includes(ext)) return 'text_1c';
    if (['.xlsx', '.xls', '.xlsm'].includes(ext)) return 'excel';
    if (['.pdf'].includes(ext)) return 'pdf';
    return 'unknown';
}

module.exports = { detectSourceKind };
