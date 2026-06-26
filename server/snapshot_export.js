const xlsx = require('xlsx');

function escapeCsvCell(val) {
    const s = val == null ? '' : String(val);
    if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function rowsToAoA(headers, rows) {
    const aoa = [headers];
    for (const row of rows) {
        aoa.push(headers.map((h) => row[h] ?? ''));
    }
    return aoa;
}

async function collectSnapshotRows(store, snapshotId) {
    const snap = await store.getSnapshot(snapshotId);
    if (!snap) return null;
    const rows = [];
    await store.fetchAllRowsBatched(snapshotId, 2000, async (batch) => {
        for (const { data } of batch) {
            const copy = { ...data };
            delete copy.__rowIndex;
            delete copy._reconcile_mismatch_columns;
            rows.push(copy);
        }
    });
    return { snap, headers: snap.headers || [], rows };
}

function snapshotExportFilename(snap, format) {
    const base = String(snap.sourceFileName || `snapshot-${snap.id}`)
        .replace(/\.(xlsx|xls|xlsm|csv)$/i, '')
        .replace(/[^\w.\-()а-яёА-ЯЁ ]/g, '_')
        .trim()
        .slice(0, 80);
    const ext = format === 'xlsx' ? 'xlsx' : 'csv';
    return `${base || 'export'}.${ext}`;
}

function buildCsvBuffer(headers, rows) {
    const lines = [];
    lines.push(headers.map(escapeCsvCell).join(';'));
    for (const row of rows) {
        lines.push(headers.map((h) => escapeCsvCell(row[h])).join(';'));
    }
    const body = `\uFEFF${lines.join('\r\n')}`;
    return Buffer.from(body, 'utf8');
}

function buildXlsxBuffer(headers, rows) {
    const ws = xlsx.utils.aoa_to_sheet(rowsToAoA(headers, rows));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Данные');
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function exportSnapshotBuffer(store, snapshotId, format = 'csv') {
    const collected = await collectSnapshotRows(store, snapshotId);
    if (!collected) return null;
    const { snap, headers, rows } = collected;
    const fmt = String(format || 'csv').toLowerCase() === 'xlsx' ? 'xlsx' : 'csv';
    const buffer = fmt === 'xlsx' ? buildXlsxBuffer(headers, rows) : buildCsvBuffer(headers, rows);
    return {
        buffer,
        filename: snapshotExportFilename(snap, fmt),
        contentType:
            fmt === 'xlsx'
                ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                : 'text/csv; charset=utf-8',
        rowCount: rows.length,
    };
}

module.exports = {
    collectSnapshotRows,
    exportSnapshotBuffer,
    buildCsvBuffer,
    buildXlsxBuffer,
    snapshotExportFilename,
};
