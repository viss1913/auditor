const { readSheetWithMeta } = require('./excel_sheet_meta');
const { findJournalHeaderRow, hasDebitCreditGeometry } = require('./structure_classifier');

/** Плоская обработанная КС — колонки уже разнесены в Excel. */
const KS_CARD_HEADERS = [
    'period',
    'document',
    'subdivision_dt',
    'counterparty',
    'contract',
    'operation_num',
    'subdivision_kt',
    'operation_name',
    'rate',
    'product_name',
    'debit_account',
    'debit_amount',
    'credit_account',
    'credit_amount',
    'quantity',
];

/** Исходная выгрузка 1С: аналитика остаётся в ячейках, как в файле. */
const KS_COMPOSITE_RAW_HEADERS = [
    'Период',
    'Документ',
    'Аналитика Дт',
    'Аналитика Кт',
    'Счёт Дт',
    'Сумма Дт',
    'Счёт Кт',
    'Сумма Кт',
    'кол-во',
    'Сальдо Д/К',
    'Текущее сальдо',
];

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
        if (t.includes('наименование') && (t.includes('товар') || t.includes('реализуем'))) {
            map.product_name = index;
        }
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

function stripLabeledField(line, label) {
    const t = String(line || '').trim();
    const colon = new RegExp(`^${label}\\s*:\\s*(.+)$`, 'i');
    const m = t.match(colon);
    if (m) return m[1].trim();
    return t;
}

function isLegalEntityLine(line) {
    const t = String(line || '').trim();
    if (!t || /^(подраздел|контрагент|договор|номер операции)/i.test(t)) return false;
    return (
        /(?:^|\s)(ООО|ОАО|АО|ПАО|ЗАО|ИП)(?:\s|$|["«])/i.test(t) ||
        /(ООО|ОАО|АО|ПАО|ЗАО|ИП)\s*$/i.test(t)
    );
}

function isInvoiceLine(line) {
    return /сч\.?\s*ф\.?|счет-фактур|с\/ф\s*№/i.test(String(line || ''));
}

function isDocumentEchoLine(line) {
    return /реализац|поступлен|акт,\s*накладн|упд\s*\d/i.test(String(line || ''));
}

/**
 * Разбор многострочной ячейки аналитики Дт: подписанные поля или позиции без подписей (выручка/реализация).
 */
function splitKsBlock2(lines) {
    const out = { subdivision_dt: '', counterparty: '', contract: '', operation_num: '' };
    if (!lines.length) return out;

    const used = new Set();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^подраздел/i.test(line)) {
            out.subdivision_dt = stripLabeledField(line, 'подразделение');
            used.add(i);
        } else if (/^контрагент/i.test(line)) {
            out.counterparty = stripLabeledField(line, 'контрагент');
            used.add(i);
        } else if (/^договор/i.test(line)) {
            out.contract = stripLabeledField(line, 'договор');
            used.add(i);
        } else if (/^номер операции/i.test(line)) {
            out.operation_num = stripLabeledField(line, 'номер операции');
            used.add(i);
        }
    }

    if (!out.counterparty) {
        const idx = lines.findIndex((l, i) => !used.has(i) && isLegalEntityLine(l));
        if (idx >= 0) {
            out.counterparty = lines[idx];
            used.add(idx);
        }
    }

    if (!out.contract) {
        const idx = lines.findIndex((l, i) => !used.has(i) && isInvoiceLine(l));
        if (idx >= 0) {
            out.contract = lines[idx];
            used.add(idx);
        }
    }

    if (!out.subdivision_dt) {
        const idx = lines.findIndex((l, i) => !used.has(i) && !isDocumentEchoLine(l));
        if (idx >= 0) out.subdivision_dt = lines[idx];
    }

    return out;
}

function formatRateValue(raw) {
    if (raw == null || raw === '') return '';
    const s = String(raw).trim();
    if (/%/.test(s)) return s;
    const n = typeof raw === 'number' ? raw : parseFloat(s.replace(',', '.'));
    if (!Number.isFinite(n)) return s;
    if (n > 0 && n <= 1) return `${Math.round(n * 100)}%`;
    return s;
}

/**
 * Разбор многострочной ячейки аналитики Кт (block3) из «Исходной КС».
 */
function splitKsBlock3(lines) {
    const out = { subdivision_kt: '', operation_name: '', rate: '', product_name: '' };
    if (!lines.length) return out;

    const used = new Set();

    const subdivIdx = lines.findIndex((l) => /подраздел/i.test(l));
    if (subdivIdx >= 0) {
        out.subdivision_kt = lines[subdivIdx];
        used.add(subdivIdx);
    } else {
        out.subdivision_kt = lines[0];
        used.add(0);
    }

    const rateIdx = lines.findIndex((l, i) => !used.has(i) && /%/.test(l));
    if (rateIdx >= 0) {
        out.rate = lines[rateIdx];
        used.add(rateIdx);
    }

    let productIdx = lines.findIndex(
        (l, i) => !used.has(i) && /наименован|товар|реализуем/i.test(l)
    );
    if (productIdx < 0) {
        const lastUnused = [...lines.keys()].reverse().find((i) => !used.has(i));
        if (lastUnused != null) productIdx = lastUnused;
    }
    if (productIdx >= 0) {
        out.product_name = lines[productIdx];
        used.add(productIdx);
    }

    const opIdx = [...lines.keys()].find((i) => !used.has(i));
    if (opIdx != null) out.operation_name = lines[opIdx];

    return out;
}

function parseKsProcessedFlat(data) {
    const headerRow = findKsHeaderRow(data);
    if (headerRow < 0) return null;

    const map = {
        ...mapHeadersToColumns(data[headerRow] || []),
        ...findDebitCreditColumns(data, headerRow),
    };

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
            subdivision_kt: cellText(row, map.subdivision_kt),
            operation_name: cellText(row, map.operation_name),
            rate: formatRateValue(row[map.rate] ?? ''),
            product_name: cellText(row, map.product_name),
            debit_account: cellText(row, map.debit_account),
            debit_amount: cellText(row, map.debit_amount),
            credit_account: cellText(row, map.credit_account),
            credit_amount: cellText(row, map.credit_amount),
            quantity: '',
        });
    }

    if (!rows.length) return null;
    return { headers: [...KS_CARD_HEADERS], rows, scenarioId: 'ks_card_flat' };
}

function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    if (!/^-?\d/.test(s)) return null;
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function inferDebitCreditFromGeometry(data, headerRow) {
    const h0 = data[headerRow] || [];
    const h1 = data[headerRow + 1] || [];
    const start = headerRow + (h1.some((c) => String(c || '').trim()) ? 2 : 1);
    const numericCols = new Map();
    for (let i = start; i < Math.min(data.length, start + 50); i++) {
        const row = data[i] || [];
        if (!/^\d{2}\.\d{2}\.\d{4}/.test(cellText(row, 0))) continue;
        for (let c = 2; c < row.length; c++) {
            if (toNum(row[c]) != null) numericCols.set(c, (numericCols.get(c) || 0) + 1);
        }
    }
    const hot = [...numericCols.entries()]
        .filter(([, n]) => n >= 2)
        .map(([c]) => c)
        .sort((a, b) => a - b);
    if (hot.length < 2) return null;

    const clusters = [];
    let cluster = [hot[0]];
    for (let i = 1; i < hot.length; i++) {
        if (hot[i] - hot[i - 1] <= 2) cluster.push(hot[i]);
        else {
            clusters.push(cluster);
            cluster = [hot[i]];
        }
    }
    clusters.push(cluster);
    if (clusters.length < 2) return null;

    const debitCluster = clusters[0];
    const creditCluster = clusters[1];
    return {
        debitAccount: debitCluster[0],
        debitAmount: debitCluster[1] ?? debitCluster[0],
        creditAccount: creditCluster[0],
        creditAmount: creditCluster[1] ?? creditCluster[0],
    };
}

function findCompositeDebitCreditCols(data) {
    let headerRow = -1;
    for (let i = 0; i < Math.min(25, data.length); i++) {
        const lower = (data[i] || []).map((c) => String(c || '').toLowerCase());
        const hasPeriod = lower.some((t) => t.includes('период'));
        const hasDebitCredit =
            lower.some((t) => t === 'дебет' || t.includes('дебет')) &&
            lower.some((t) => t === 'кредит' || t.includes('кредит'));
        if (hasPeriod && hasDebitCredit) {
            headerRow = i;
            break;
        }
    }
    if (headerRow < 0) {
        const journal = findJournalHeaderRow(data);
        if (journal.headerRow >= 0 && hasDebitCreditGeometry(data, journal.headerRow)) {
            headerRow = journal.headerRow;
        }
    }
    if (headerRow < 0) return null;

    const h0 = data[headerRow] || [];
    const h1 = data[headerRow + 1] || [];
    let debitAccount = -1;
    let debitAmount = -1;
    let creditAccount = -1;
    let creditAmount = -1;
    let balanceSideCol = -1;
    let balanceAmountCol = -1;

    for (let c = 0; c < h0.length; c++) {
        const t = String(h0[c] || '').trim().toLowerCase();
        if ((t === 'дебет' || t.startsWith('дебет')) && debitAccount < 0) {
            debitAccount = c;
            const sub = String(h1[c] || '').toLowerCase();
            if (/сумма/.test(sub)) debitAmount = c;
            else debitAmount = c + 1;
        }
        if ((t === 'кредит' || t.startsWith('кредит')) && creditAccount < 0) {
            creditAccount = c;
            const sub = String(h1[c] || '').toLowerCase();
            if (/сумма/.test(sub)) creditAmount = c;
            else creditAmount = c + 1;
        }
        if (/текущее\s*сальдо|сальдо/.test(t) && balanceSideCol < 0) {
            balanceSideCol = c;
            const sub = String(h1[c] || '').toLowerCase();
            if (/сумма/.test(sub)) balanceAmountCol = c;
            else if (c + 1 < h0.length) balanceAmountCol = c + 1;
        }
    }

    if (debitAccount < 0 || creditAccount < 0) {
        const geom = inferDebitCreditFromGeometry(data, headerRow);
        if (!geom) return null;
        debitAccount = geom.debitAccount;
        debitAmount = geom.debitAmount;
        creditAccount = geom.creditAccount;
        creditAmount = geom.creditAmount;
    }

    const dataStartRow = headerRow + (h1.some((c) => String(c || '').trim()) ? 2 : 1);
    return {
        headerRow,
        dataStartRow,
        debitAccount,
        debitAmount,
        creditAccount,
        creditAmount,
        balanceSideCol,
        balanceAmountCol,
    };
}

function findAnalyticsColumns(data, headerRow) {
    const h0 = data[headerRow] || [];
    const cols = [];
    for (let c = 0; c < h0.length; c++) {
        const t = String(h0[c] || '').toLowerCase();
        if (t.includes('аналитика')) cols.push(c);
    }
    if (cols.length >= 2) return { analyticsDt: cols[0], analyticsKt: cols[1] };
    if (cols.length === 1) return { analyticsDt: cols[0], analyticsKt: cols[0] + 1 };
    return { analyticsDt: 2, analyticsKt: 3 };
}

function findQuantityColumn(data, headerRow = 0) {
    const h0 = data[headerRow] || [];
    for (let c = 0; c < h0.length; c++) {
        const t = String(h0[c] || '').toLowerCase().replace(/\s/g, '');
        if (t === 'кол-во' || t === 'колво' || t === 'количество') return c;
    }
    return -1;
}

function normalizeAnalyticsCell(val) {
    return String(val ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}

function parseKsSourceComposite(data) {
    const cols = findCompositeDebitCreditCols(data);
    if (!cols) return null;

    const { analyticsDt, analyticsKt } = findAnalyticsColumns(data, cols.headerRow);
    const periodCol = 0;
    const documentCol = analyticsDt > 1 ? 1 : 1;
    const debitAccountCol = cols.debitAccount;
    const debitAmountCol = cols.debitAmount;
    const creditAccountCol = cols.creditAccount;
    const creditAmountCol = cols.creditAmount;
    const startRow = cols.dataStartRow;
    const quantityCol = findQuantityColumn(data, cols.headerRow);
    const balanceSideCol = cols.balanceSideCol;
    const balanceAmountCol = cols.balanceAmountCol;
    const rows = [];

    for (let i = startRow; i < data.length; i++) {
        const row = data[i] || [];
        const period = cellText(row, periodCol);
        const isOpeningBalance = /сальдо\s+на\s+начало/i.test(period);
        const isDatedRow = /^\d{2}\.\d{2}\.\d{4}/.test(period);
        if (!isDatedRow && !isOpeningBalance) continue;

        const out = {
            Период: period,
            Документ: normalizeAnalyticsCell(row[documentCol]),
            'Аналитика Дт': normalizeAnalyticsCell(row[analyticsDt]),
            'Аналитика Кт': normalizeAnalyticsCell(row[analyticsKt]),
            'Счёт Дт': cellText(row, debitAccountCol),
            'Сумма Дт': cellText(row, debitAmountCol),
            'Счёт Кт': cellText(row, creditAccountCol),
            'Сумма Кт': cellText(row, creditAmountCol),
            'кол-во': quantityCol >= 0 ? cellText(row, quantityCol) : '',
        };
        out['Сальдо Д/К'] = balanceSideCol >= 0 ? cellText(row, balanceSideCol) : '';
        out['Текущее сальдо'] = balanceAmountCol >= 0 ? cellText(row, balanceAmountCol) : '';
        rows.push(out);
    }

    if (!rows.length) return null;
    return { headers: [...KS_COMPOSITE_RAW_HEADERS], rows, scenarioId: 'ks_card_composite_raw' };
}

/**
 * Следующий этап: раскрыть многострочную аналитику в плоские колонки (по запросу аудитора).
 */
function expandKsCompositeRow(row) {
    const analyticsDt = row['Аналитика Дт'] ?? row.analytics_dt ?? '';
    const analyticsKt = row['Аналитика Кт'] ?? row.analytics_kt ?? '';
    const block2Fields = splitKsBlock2(splitCompositeLines(analyticsDt));
    const block3Fields = splitKsBlock3(splitCompositeLines(analyticsKt));

    return {
        period: row['Период'] ?? row.period ?? '',
        document: String(row['Документ'] ?? row.document ?? '').replace(/\r?\n/g, ' ').trim(),
        subdivision_dt: block2Fields.subdivision_dt,
        counterparty: block2Fields.counterparty,
        contract: block2Fields.contract,
        operation_num: block2Fields.operation_num,
        subdivision_kt: block3Fields.subdivision_kt,
        operation_name: block3Fields.operation_name,
        rate: block3Fields.rate,
        product_name: block3Fields.product_name,
        debit_account: row['Счёт Дт'] ?? row.debit_account ?? '',
        debit_amount: row['Сумма Дт'] ?? row.debit_amount ?? '',
        credit_account: row['Счёт Кт'] ?? row.credit_account ?? '',
        credit_amount: row['Сумма Кт'] ?? row.credit_amount ?? '',
        quantity: row['кол-во'] ?? row.quantity ?? '',
        balance_side: row['Сальдо Д/К'] ?? row.balance_side ?? '',
        current_balance: row['Текущее сальдо'] ?? row.current_balance ?? '',
    };
}

function expandKsCompositeRows(rows) {
    return (rows || []).map((row) => expandKsCompositeRow(row));
}

function hasCompositeAnalyticsColumns(headers = []) {
    const h = headers.map((x) => String(x || '').toLowerCase());
    return h.some((x) => x.includes('аналитика') && x.includes('дт'));
}

function isCompositeJournalLayout(data) {
    const cols = findCompositeDebitCreditCols(data);
    if (!cols) return false;
    const flatHeader = findKsHeaderRow(data);
    if (flatHeader < 0) return true;
    const map = mapHeadersToColumns(data[flatHeader] || []);
    return !(map.counterparty != null || map.contract != null);
}

function parseKsSheetFromData(data) {
    if (!data?.length) return null;
    if (isCompositeJournalLayout(data)) {
        return parseKsSourceComposite(data) || parseKsProcessedFlat(data);
    }
    return parseKsProcessedFlat(data) || parseKsSourceComposite(data);
}

function parseKsSheet(buffer, sheetName) {
    return parseKsSheetFromData(loadSheetRows(buffer, sheetName));
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
        parsePreview: { ok: true, headers: parsed.headers, rows: previewRows, rowCount },
        warnings: [],
    };
}

async function tryParseKsSheet({ pool, file, sheetName, projectId, data }) {
    const parsed = data ? parseKsSheetFromData(data) : parseKsSheet(file.buffer, sheetName);
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
    KS_CARD_HEADERS,
    KS_COMPOSITE_RAW_HEADERS,
    isKsSheetName,
    parseKsSheet,
    parseKsSheetFromData,
    tryParseKsSheet,
    parseKsProcessedFlat,
    parseKsSourceComposite,
    findCompositeDebitCreditCols,
    expandKsCompositeRow,
    expandKsCompositeRows,
    hasCompositeAnalyticsColumns,
    splitKsBlock2,
    splitKsBlock3,
    splitCompositeLines,
};
