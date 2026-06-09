const { readSheetWithMeta } = require('./excel_sheet_meta');

function cellText(row, col) {
    return String((row && row[col]) ?? '').trim();
}

function cellNum(row, col) {
    const t = cellText(row, col);
    if (!t) return '';
    return t;
}

function isProcessedOsvSheetName(sheetName) {
    return /обработанн.*осв/i.test(String(sheetName || ''));
}

function findFlatOsvHeaderRow(data) {
    for (let i = 0; i < Math.min(20, data.length); i++) {
        const row = data[i] || [];
        const lower = row.map((c) => String(c || '').toLowerCase());
        const hasAccount = lower.some(
            (t) => t.includes('наименование счета') || t.includes('счет, наименование')
        );
        const hasSubdivision = lower.some((t) => t.includes('подразделение'));
        const hasCounterparty = lower.some((t) => t.includes('контрагент'));
        const hasContract = lower.some((t) => t.includes('договор'));
        if (hasAccount && hasSubdivision && hasCounterparty && hasContract) return i;
    }
    return -1;
}

function isFlatOsvData(data) {
    const headerRow = findFlatOsvHeaderRow(data);
    if (headerRow < 0) return false;
    let dataRows = 0;
    for (let i = headerRow + 1; i < Math.min(headerRow + 8, data.length); i++) {
        const row = data[i] || [];
        if (cellText(row, 1) && cellText(row, 2) && cellText(row, 3)) dataRows++;
    }
    return dataRows >= 2;
}

function mapFlatOsvColumns(data, headerRow) {
    const headers = data[headerRow] || [];
    const map = {
        account: 0,
        subdivision: 1,
        counterparty: 2,
        contract: 3,
        open_debit: 4,
        open_credit: 5,
        turnover_debit: 6,
        turnover_credit: 7,
        close_debit: 8,
        close_credit: 9,
    };

    headers.forEach((h, index) => {
        const t = String(h || '').toLowerCase();
        if (t.includes('наименование счета') || t.includes('счет, наименование')) map.account = index;
        if (t.includes('подразделение')) map.subdivision = index;
        if (t.includes('контрагент')) map.counterparty = index;
        if (t.includes('договор')) map.contract = index;
    });

    const sub = data[headerRow + 1] || data[headerRow - 1] || [];
    const metricLabels = (data[headerRow - 1] || data[headerRow + 1] || []).map((c) =>
        String(c || '').toLowerCase()
    );
    const debitCreditRow = sub.map((c) => String(c || '').toLowerCase());
    const dcRow =
        debitCreditRow.filter((t) => t.includes('дебет') || t.includes('кредит')).length >= 4
            ? debitCreditRow
            : metricLabels;

    let metricCol = Math.max(map.contract, map.counterparty, map.subdivision, map.account) + 1;
    const metrics = ['open_debit', 'open_credit', 'turnover_debit', 'turnover_credit', 'close_debit', 'close_credit'];
    let mi = 0;
    for (let c = metricCol; c < dcRow.length && mi < metrics.length; c++) {
        const t = dcRow[c] || metricLabels[c] || '';
        if (t.includes('дебет') || t.includes('кредит') || t === '') {
            if (t.includes('дебет') || (t === '' && mi % 2 === 0)) map[metrics[mi]] = c;
            else if (t.includes('кредит') || t === '') map[metrics[mi]] = c;
            mi++;
        }
    }

    return map;
}

function parseOsvFlatSheet(buffer, sheetName) {
    const data = readSheetWithMeta(buffer, sheetName, { useExcelProbe: true }).data || [];
    if (!isFlatOsvData(data) && !isProcessedOsvSheetName(sheetName)) return null;

    const headerRow = findFlatOsvHeaderRow(data);
    if (headerRow < 0) return null;

    const map = mapFlatOsvColumns(data, headerRow);
    const headers = [
        'Счёт, наименование счета',
        'Подразделение',
        'Контрагент',
        'Договор',
        'Сальдо Дт начало',
        'Сальдо Кт начало',
        'Оборот Дт',
        'Оборот Кт',
        'Сальдо Дт конец',
        'Сальдо Кт конец',
    ];

    const rows = [];
    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i] || [];
        const account = cellText(row, map.account);
        const subdivision = cellText(row, map.subdivision);
        const counterparty = cellText(row, map.counterparty);
        const contract = cellText(row, map.contract);
        if (!account && !subdivision && !counterparty && !contract) continue;
        if (!subdivision && !counterparty && !contract) continue;

        rows.push({
            'Счёт, наименование счета': account,
            Подразделение: subdivision,
            Контрагент: counterparty,
            Договор: contract,
            'Сальдо Дт начало': cellNum(row, map.open_debit),
            'Сальдо Кт начало': cellNum(row, map.open_credit),
            'Оборот Дт': cellNum(row, map.turnover_debit),
            'Оборот Кт': cellNum(row, map.turnover_credit),
            'Сальдо Дт конец': cellNum(row, map.close_debit),
            'Сальдо Кт конец': cellNum(row, map.close_credit),
        });
    }

    if (!rows.length) return null;
    return { headers, rows, scenarioId: 'osv_flat_processed' };
}

async function importOsvFlatToSnapshot(pool, { file, sheetName, projectId, parsed }) {
    const { createParseSnapshotStore } = require('./parse_snapshot_store');
    const store = createParseSnapshotStore(pool);
    const sid = await store.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: file.originalname,
        sheetName,
        scenarioId: parsed.scenarioId,
        headers: parsed.headers,
        status: 'parsing',
    });
    const rowCount = await store.importParsedRows(sid, parsed.headers, parsed.rows);
    return {
        ok: true,
        snapshotId: sid,
        parsePreview: { headers: parsed.headers, rows: parsed.rows.slice(0, 200), rowCount },
        warnings: [],
    };
}

async function tryParseOsvFlatSheet({ pool, file, sheetName, projectId }) {
    const data = readSheetWithMeta(file.buffer, sheetName).data || [];
    if (!isProcessedOsvSheetName(sheetName) && !isFlatOsvData(data)) return null;

    const parsed = parseOsvFlatSheet(file.buffer, sheetName);
    if (!parsed?.rows?.length) return null;

    const imported = await importOsvFlatToSnapshot(pool, { file, sheetName, projectId, parsed });
    return {
        ok: true,
        sheetName,
        scenarioId: parsed.scenarioId,
        scenarioName: 'ОСВ плоская (обработанная)',
        snapshotId: imported.snapshotId,
        rowCount: imported.parsePreview.rowCount,
        parsePreview: imported.parsePreview,
        warnings: imported.warnings,
    };
}

module.exports = {
    isProcessedOsvSheetName,
    isFlatOsvData,
    findFlatOsvHeaderRow,
    parseOsvFlatSheet,
    tryParseOsvFlatSheet,
};
