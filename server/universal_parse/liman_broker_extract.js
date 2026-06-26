/**
 * Landmark Capital / LMC — Investment Account Statement (English).
 */

const { extractTextItems, clusterRows } = require('./pdfjs_table_grid_extract');

const LMC_CASH_HEADERS = ['Section', 'Line item', 'USD', 'EUR', 'RUB', 'AMD'];

const LMC_ACCOUNT_HEADERS = ['Field', 'Value'];

const LMC_AMOUNT_RE = /^-?(\d{1,3}(,\d{3})*|\d+)\.\d{2}$/;
const LMC_SECTION_RE =
    /^(Trading Transactions|Non-Trading Transactions)(\s*\(Pending\))?$/i;

const LMC_ACCOUNT_FIELDS = [
    'Client Name',
    'Client Code',
    'Account Number',
    'Account Type',
    'Account Status',
    'Account Currency',
    'Account Value',
    'Reporting Date',
];

function parseLmcAmountRow(gridRow) {
    const items = [...(gridRow.items || [])].sort((a, b) => a.x - b.x);
    const text = String(gridRow.text || '').trim();
    if (!text || /^USD\s+EUR\s+RUB/i.test(text)) return null;

    if (LMC_SECTION_RE.test(text)) {
        return { kind: 'section', section: text };
    }

    const amounts = items.filter((it) => LMC_AMOUNT_RE.test(String(it.text || '').trim()));
    const label = items
        .filter((it) => !LMC_AMOUNT_RE.test(String(it.text || '').trim()))
        .map((it) => it.text)
        .join(' ')
        .trim();

    if (!label) return null;
    if (amounts.length === 4) {
        return {
            kind: 'data',
            label,
            amounts: amounts.map((it) => it.text),
        };
    }
    if (amounts.length === 0) {
        return { kind: 'section', section: label };
    }
    return null;
}

function findCashBalanceBounds(rows) {
    const start = rows.findIndex((r) => /^Cash\s+Balance$/i.test(String(r.text || '').trim()));
    if (start < 0) return null;

    let dataStart = -1;
    for (let i = start + 1; i < rows.length; i++) {
        if (/^USD\s+EUR\s+RUB/i.test(rows[i].text)) {
            dataStart = i + 1;
            break;
        }
    }
    if (dataStart < 0) return null;

    let end = rows.length;
    for (let i = dataStart; i < rows.length; i++) {
        const t = String(rows[i].text || '').trim();
        if (/^Landmark\s+Capital/i.test(t) || /^Report\s+generation/i.test(t) || /^\*/.test(t)) {
            end = i;
            break;
        }
    }

    return { dataStart, end };
}

async function extractLmcCashBalanceFromBuffer(buffer) {
    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const bounds = findCashBalanceBounds(rows);
    if (!bounds) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'lmc_cash_balance' };
    }

    const parsedRows = [];
    let currentSection = 'Cash Balance';

    for (let i = bounds.dataStart; i < bounds.end; i++) {
        const parsed = parseLmcAmountRow(rows[i]);
        if (!parsed) continue;

        if (parsed.kind === 'section') {
            currentSection = parsed.section;
            continue;
        }

        parsedRows.push({
            Section: currentSection,
            'Line item': parsed.label,
            USD: parsed.amounts[0],
            EUR: parsed.amounts[1],
            RUB: parsed.amounts[2],
            AMD: parsed.amounts[3],
        });
    }

    if (!parsedRows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'lmc_cash_balance' };
    }

    return {
        ok: true,
        headers: LMC_CASH_HEADERS,
        rows: parsedRows,
        confidence: 0.88,
        method: 'lmc_cash_balance',
    };
}

function cleanLmcAccountValue(field, value) {
    let v = String(value || '').trim();
    v = v.replace(/\s+(EUR|USD|RUB|AMD)\/[A-Z]{3}\s+[\d.,]+$/i, '').trim();
    if (field === 'Account Value') {
        v = v.replace(/\*$/, '').trim();
    }
    return v;
}

function parseLmcAccountFieldRow(gridRow) {
    const items = [...(gridRow.items || [])].sort((a, b) => a.x - b.x);
    if (!items.length) return null;

    for (const field of LMC_ACCOUNT_FIELDS) {
        const hasField = items.some((it) => new RegExp(`^${field}\\*?:`, 'i').test(String(it.text || '').trim()));
        if (!hasField) continue;

        const valueItem = items.find(
            (it) => it.x >= 100 && it.x <= 220 && !new RegExp(`^${field}`, 'i').test(String(it.text || ''))
        );
        return { Field: field, Value: cleanLmcAccountValue(field, valueItem?.text || '') };
    }
    return null;
}

async function extractLmcAccountInfoFromBuffer(buffer) {
    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const parsedRows = [];

    for (const row of rows) {
        const rec = parseLmcAccountFieldRow(row);
        if (rec) parsedRows.push(rec);
    }

    if (!parsedRows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'lmc_account_info' };
    }

    return {
        ok: true,
        headers: LMC_ACCOUNT_HEADERS,
        rows: parsedRows,
        confidence: 0.9,
        method: 'lmc_account_info',
    };
}

/**
 * @param {Buffer} buffer
 */
async function extractLimanBrokerPdfTables(buffer) {
    const sections = [];

    const cash = await extractLmcCashBalanceFromBuffer(buffer);
    if (cash.ok && cash.rows.length) {
        sections.push({
            id: 'cash_balance',
            label: 'Cash Balance',
            headers: cash.headers,
            rows: cash.rows,
            confidence: cash.confidence,
            method: cash.method,
        });
    }

    const account = await extractLmcAccountInfoFromBuffer(buffer);
    if (account.ok && account.rows.length) {
        sections.push({
            id: 'account_info',
            label: 'Account Information',
            headers: account.headers,
            rows: account.rows,
            confidence: account.confidence,
            method: account.method,
        });
    }

    return sections;
}

module.exports = {
    LMC_CASH_HEADERS,
    LMC_ACCOUNT_HEADERS,
    extractLimanBrokerPdfTables,
    extractLmcCashBalanceFromBuffer,
    extractLmcAccountInfoFromBuffer,
    parseLmcAmountRow,
};
