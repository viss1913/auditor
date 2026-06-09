const { readSheetWithMeta } = require('./excel_sheet_meta');

function cellText(row, col) {
    return String((row && row[col]) ?? '').trim();
}

function isKsSheetName(sheetName) {
    return /кс/i.test(String(sheetName || ''));
}

function loadSheetRows(buffer, sheetName) {
    const loaded = readSheetWithMeta(buffer, sheetName, { useExcelProbe: true });
    return loaded.data || [];
}

function findKsHeaderRow(data) {
    for (let i = 0; i < Math.min(25, data.length); i++) {
        const row = data[i] || [];
        const lower = row.map((c) => String(c || '').toLowerCase());
        if (lower.some((t) => t.includes('период')) && lower.some((t) => t.includes('контрагент'))) {
            return i;
        }
    }
    return -1;
}

function mapHeadersToColumns(headers) {
    const map = {};
    headers.forEach((h, index) => {
        const t = String(h || '').toLowerCase();
        if (!t) return;
        if (t.includes('период')) map.period = index;
        if (t === 'документ' || t.startsWith('документ')) map.document = index;
        if (t.includes('подразделение') && t.includes('дт')) map.subdivision_dt = index;
        if (t.includes('подразделение') && t.includes('кт')) map.subdivision_kt = index;
        if (t.includes('контрагент')) map.counterparty = index;
        if (t.includes('договор')) map.contract = index;
        if (t.includes('номер операции')) map.operation_num = index;
        if (t.includes('наименование операции')) map.operation_name = index;
        if (t.includes('ставка')) map.rate = index;
        if (t.includes('наименование') && t.includes('товар')) map.product = index;
        if (t.includes('сальдо')) map.balance = index;
    });
    return map;
}

function findDebitCreditColumns(data, headerRow) {
    const headers = data[headerRow] || [];
    const sub = data[headerRow + 1] || [];
    const out = {};
    for (let i = 0; i < headers.length; i++) {
        const t = String(headers[i] || '').toLowerCase();
        if (t !== 'дебет' && t !== 'кредит') continue;
        const keyPrefix = t === 'дебет' ? 'debit' : 'credit';
        let end = i + 1;
        while (end < headers.length && !String(headers[end] || '').trim()) end++;
        for (let j = i; j < end && j < sub.length; j++) {
            const st = String(sub[j] || '').toLowerCase();
            if (/счет|счёт/.test(st)) out[`${keyPrefix}_account`] = j;
            if (st.includes('сумма')) out[`${keyPrefix}_amount`] = j;
        }
    }
    return out;
}

function splitCompositeLines(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function pickLine(lines, pattern) {
    return lines.find((l) => pattern.test(l)) || '';
}

function parseKsProcessedFlat(data) {
    const headerRow = findKsHeaderRow(data);
    if (headerRow < 0) return null;

    const map = {
        ...mapHeadersToColumns(data[headerRow] || []),
        ...findDebitCreditColumns(data, headerRow),
    };

    const headers = [
        'period',
        'document',
        'subdivision_dt',
        'counterparty',
        'contract',
        'operation_num',
        'operation_name',
        'debit_account',
        'debit_amount',
        'credit_account',
        'credit_amount',
    ];

    const rows = [];
    for (let i = headerRow + 1; i < data.length; i++) {
        const row = data[i] || [];
        const period = cellText(row, map.period ?? 0);
        if (!/^\d{2}\.\d{2}\.\d{4}/.test(period)) continue;

        rows.push({
            period,
            document: cellText(row, map.document).replace(/\r?\n/g, ' '),
            subdivision_dt: cellText(row, map.subdivision_dt),
            counterparty: cellText(row, map.counterparty),
            contract: cellText(row, map.contract),
            operation_num: cellText(row, map.operation_num),
            operation_name: cellText(row, map.operation_name),
            debit_account: cellText(row, map.debit_account),
            debit_amount: cellText(row, map.debit_amount),
            credit_account: cellText(row, map.credit_account),
            credit_amount: cellText(row, map.credit_amount),
        });
    }

    if (!rows.length) return null;
    return { headers, rows, scenarioId: 'ks_card_flat' };
}

function parseKsSourceComposite(data) {
    const headers = [
        'period',
        'document',
        'subdivision',
        'counterparty',
        'contract',
        'operation_num',
        'product',
        'debit_account',
        'credit_account',
        'credit_amount',
    ];
    const rows = [];

    for (let i = 0; i < data.length; i++) {
        const row = data[i] || [];
        const period = cellText(row, 0);
        if (!/^\d{2}\.\d{2}\.\d{4}/.test(period)) continue;

        const block2 = splitCompositeLines(row[2]);
        const block3 = splitCompositeLines(row[3]);

        rows.push({
            period,
            document: cellText(row, 1).replace(/\r?\n/g, ' '),
            subdivision: pickLine(block2, /подразделение/i) || block2[0] || '',
            counterparty: pickLine(block2, /контрагент/i) || '',
            contract: pickLine(block2, /договор/i) || '',
            operation_num: pickLine(block2, /номер операции/i) || '',
            product: block3.join(' · '),
            debit_account: cellText(row, 4),
            credit_account: cellText(row, 7),
            credit_amount: cellText(row, 8),
        });
    }

    if (!rows.length) return null;
    return { headers, rows, scenarioId: 'ks_card_composite' };
}

function parseKsSheet(buffer, sheetName) {
    const data = loadSheetRows(buffer, sheetName);
    if (!data.length) return null;

    const isSource = /исходн/i.test(sheetName);
    if (isSource) {
        return parseKsSourceComposite(data) || parseKsProcessedFlat(data);
    }
    return parseKsProcessedFlat(data) || parseKsSourceComposite(data);
}

async function importKsParseToSnapshot(pool, { file, sheetName, projectId, parsed }) {
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
    const previewRows = parsed.rows.slice(0, 200);
    return {
        ok: true,
        snapshotId: sid,
        parsePreview: { headers: parsed.headers, rows: previewRows, rowCount },
        warnings: [],
    };
}

async function tryParseKsSheet({ pool, file, sheetName, projectId }) {
    if (!isKsSheetName(sheetName)) return null;
    const parsed = parseKsSheet(file.buffer, sheetName);
    if (!parsed?.rows?.length) return null;

    const imported = await importKsParseToSnapshot(pool, { file, sheetName, projectId, parsed });
    if (!imported.ok) return null;

    return {
        ok: true,
        sheetName,
        scenarioId: parsed.scenarioId,
        scenarioName: 'Карточка счёта (КС)',
        snapshotId: imported.snapshotId,
        rowCount: imported.parsePreview.rowCount,
        parsePreview: imported.parsePreview,
        warnings: imported.warnings,
    };
}

module.exports = {
    isKsSheetName,
    parseKsSheet,
    tryParseKsSheet,
    parseKsProcessedFlat,
    parseKsSourceComposite,
};
