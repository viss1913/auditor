/**
 * Orion Central Asia / SOLAR — ClientReportForThePeriod (English).
 * Example file name:
 *   ClientReportForThePeriod_20251215_20251231_30000500_USD.pdf
 *
 * We extract a few key sections using the clustered text layer (pdfjs):
 * - Account info (Client/Account Number/Report Currency/Date range)
 * - Current balance for the period (cash balance line)
 * - Planned balance for the period (cash balance line)
 * - Cash Deposits/Withdrawals table (n12728 ... lines)
 * - Conversion Transactions (fx operation line with rate and both currency quantities)
 */

const { extractTextItems, clusterRows } = require('./pdfjs_table_grid_extract');

const ORION_CLIENT_FIELDS = [
    'Client',
    'Account Type',
    'Account Number',
    'Report Currency',
    'Agreement Date',
];

function normalizeNumberString(s) {
    return String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(',', '.')
        .replace(/[^0-9.\-]/g, '');
}

function parseOrionCashBalanceLine(line) {
    // Example:
    //   Cash Balance USD 0,00 0,00 6 060,95 6 060,95
    // Columns: Beginning Quantity / Beginning In report currency / End Quantity / End In report currency
    const t = String(line || '').replace(/\s+/g, ' ').trim();
    const m = t.match(
        /^Cash\s+Balance\s+([A-Z]{3})\s+(-?[\d\s]+,\d{2})\s+(-?[\d\s]+,\d{2})\s+(-?[\d\s]+,\d{2})\s+(-?[\d\s]+,\d{2})$/i
    );
    if (!m) return null;
    return {
        currency: m[1].toUpperCase(),
        bQty: m[2],
        bAmt: m[3],
        eQty: m[4],
        eAmt: m[5],
    };
}

function parseOrionSecuritiesValueLine(line) {
    // Example:
    //   Securities value - 0,00 0,00 0,00 0,00
    const t = String(line || '').replace(/\s+/g, ' ').trim();
    const m = t.match(
        /^Securities\s+value\s+-?\s*(-?[\d\s]+,\d{2})\s+(-?[\d\s]+,\d{2})\s+(-?[\d\s]+,\d{2})\s+(-?[\d\s]+,\d{2})$/i
    );
    if (!m) return null;
    return { bQty: m[1], bAmt: m[2], eQty: m[3], eAmt: m[4] };
}

function parseCashDepositRow(line) {
    // Example:
    //   n12728 Credited to the account 24.12.2025 24.12.2025 4 400 000,00 RUB
    const t = String(line || '').replace(/\s+/g, ' ').trim();
    const m = t.match(
        /^(n\d+)\s+(.+?)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s+(-?[\d\s]+,\d{2})\s+([A-Z]{3})$/i
    );
    if (!m) return null;

    return {
        'Operation Number': m[1],
        'Operation Description': m[2].trim(),
        'Operation Date': m[3],
        'Payment Date': m[4],
        'Amount, Currency': `${m[6].toUpperCase()} ${m[5].replace(/\s+/g, '')}`,
        Amount: m[5].replace(/\s+/g, ''),
        Currency: m[6].toUpperCase(),
    };
}

function parseConversionRateAndFxLine(lines, fxLineIdx) {
    // We expect two adjacent lines:
    //  - one with rate (e.g. "78.4860 RUB /")
    //  - one with fx operation and both currency quantities (e.g. "fx6280 29.12.2025 ... RUB 4 400 000,00 USD 56 060,95")
    const rateLine = fxLineIdx > 0 ? lines[fxLineIdx - 1] : '';
    const rateM = String(rateLine).match(/([\d]+,\d{4}|[\d]+\.\d{4}|[\d]+\.\d{3,4})/);
    const rate = rateM ? rateM[1].replace(/\s+/g, '') : '';

    const fxT = String(lines[fxLineIdx] || '').replace(/\s+/g, ' ').trim();
    // Try to capture: fx####, date, debitedCurrency qty, creditedCurrency qty
    const fxM = fxT.match(
        /(fx\d+)\s+(\d{2}\.\d{2}\.\d{4})\s+(\d{2}\.\d{2}\.\d{4})\s+([A-Z]{3})\s+(-?[\d\s]+,\d{2})\s+([A-Z]{3})\s+(-?[\d\s]+,\d{2})/i
    );
    if (!fxM) return null;

    return {
        'Operation Number': fxM[1],
        'Operation Date': fxM[2],
        'Payment Date': fxM[3],
        'Debited Currency': fxM[4].toUpperCase(),
        'Debited Quantity': fxM[5].replace(/\s+/g, ''),
        'Credited Currency': fxM[6].toUpperCase(),
        'Credited Quantity': fxM[7].replace(/\s+/g, ''),
        Rate: rate,
    };
}

async function extractOrionClientReportTables(buffer) {
    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const allTexts = rows.map((r) => String(r.text || '').trim()).filter(Boolean);

    const sections = [];

    // --- Account info ---
    const reportInfoLine = allTexts.find((t) => /^Report\s+for\s+the\s+period/i.test(t)) || '';
    const periodM = reportInfoLine.match(/(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})/);
    const periodStart = periodM ? periodM[1] : '';
    const periodEnd = periodM ? periodM[2] : '';

    const accountRows = [];
    for (const line of allTexts) {
        for (const field of ORION_CLIENT_FIELDS) {
            const re = new RegExp(`^${field.replace(/[.*+?^${}()|[\\\\]\\\\]/g, '\\$&')}\\\\s+(.+)$`, 'i');
            const m = line.match(re);
            if (!m) continue;
            accountRows.push({ Field: field, Value: m[1].trim() });
        }
        if (/^Report Currency/i.test(line)) continue;
    }

    if (accountRows.length) {
        sections.push({
            id: 'account_info',
            label: 'Account Information',
            headers: ['Field', 'Value'],
            rows: accountRows,
            confidence: 0.9,
            method: 'orion_account_info',
        });
    }

    // --- Current/Planned balance blocks ---
    // In PDF they look like:
    //   Current Balance for the period (...)
    //   ... then rows:
    //     Securities value - <bQty> <bAmt> <eQty> <eAmt>
    //     Cash Balance USD <bQty> <bAmt> <eQty> <eAmt>
    const curIdx = allTexts.findIndex((t) => /Current Balance for the period/i.test(t));
    const plIdx = allTexts.findIndex((t) => /Planned Balance for the period/i.test(t));

    function findBalanceLines(headingIdx) {
        if (headingIdx < 0) return null;
        let secLine = null;
        let cashLine = null;
        for (let i = headingIdx; i < Math.min(allTexts.length, headingIdx + 25); i++) {
            const t = allTexts[i] || '';
            if (!secLine && /^Securities\s+value/i.test(t)) secLine = t;
            if (!cashLine && /^Cash\s+Balance/i.test(t)) cashLine = t;
            if (secLine && cashLine) break;
        }
        return secLine && cashLine ? { secLine, cashLine } : null;
    }

    const balanceHeaders = [
        'Line item',
        'Currency',
        'Beginning Quantity',
        'Beginning In report currency',
        'End Quantity',
        'End In report currency',
    ];

    const curLines = findBalanceLines(curIdx);
    if (curLines) {
        const sec = parseOrionSecuritiesValueLine(curLines.secLine);
        const cash = parseOrionCashBalanceLine(curLines.cashLine);
        if (sec && cash) {
            sections.push({
                id: 'current_balance',
                label: `Current Balance (${periodStart || ''} - ${periodEnd || ''})`.trim(),
                headers: balanceHeaders,
                rows: [
                    {
                        'Line item': 'Securities value',
                        Currency: '-',
                        'Beginning Quantity': sec.bQty.replace(/\s+/g, ''),
                        'Beginning In report currency': sec.bAmt.replace(/\s+/g, ''),
                        'End Quantity': sec.eQty.replace(/\s+/g, ''),
                        'End In report currency': sec.eAmt.replace(/\s+/g, ''),
                    },
                    {
                        'Line item': 'Cash Balance',
                        Currency: cash.currency,
                        'Beginning Quantity': cash.bQty.replace(/\s+/g, ''),
                        'Beginning In report currency': cash.bAmt.replace(/\s+/g, ''),
                        'End Quantity': cash.eQty.replace(/\s+/g, ''),
                        'End In report currency': cash.eAmt.replace(/\s+/g, ''),
                    },
                ],
                confidence: 0.85,
                method: 'orion_current_balance_block',
            });
        }
    }

    const plLines = findBalanceLines(plIdx);
    if (plLines) {
        const sec = parseOrionSecuritiesValueLine(plLines.secLine);
        const cash = parseOrionCashBalanceLine(plLines.cashLine);
        if (sec && cash) {
            sections.push({
                id: 'planned_balance',
                label: `Planned Balance (${periodStart || ''} - ${periodEnd || ''})`.trim(),
                headers: balanceHeaders,
                rows: [
                    {
                        'Line item': 'Securities value',
                        Currency: '-',
                        'Beginning Quantity': sec.bQty.replace(/\s+/g, ''),
                        'Beginning In report currency': sec.bAmt.replace(/\s+/g, ''),
                        'End Quantity': sec.eQty.replace(/\s+/g, ''),
                        'End In report currency': sec.eAmt.replace(/\s+/g, ''),
                    },
                    {
                        'Line item': 'Cash Balance',
                        Currency: cash.currency,
                        'Beginning Quantity': cash.bQty.replace(/\s+/g, ''),
                        'Beginning In report currency': cash.bAmt.replace(/\s+/g, ''),
                        'End Quantity': cash.eQty.replace(/\s+/g, ''),
                        'End In report currency': cash.eAmt.replace(/\s+/g, ''),
                    },
                ],
                confidence: 0.85,
                method: 'orion_planned_balance_block',
            });
        }
    }

    // --- Cash Deposits/Withdrawals ---
    const cashStartIdx = allTexts.findIndex((t) => /Cash Deposits\/Withdrawals/i.test(t));
    const convIdx = allTexts.findIndex((t) => /Conversion Transactions/i.test(t));
    if (cashStartIdx >= 0) {
        const data = [];
        const end = convIdx >= 0 ? convIdx : allTexts.length;
        for (let i = cashStartIdx; i < end; i++) {
            const parsed = parseCashDepositRow(allTexts[i]);
            if (!parsed) continue;
            data.push(parsed);
        }
        if (data.length) {
            sections.push({
                id: 'cash_deposits_withdrawals',
                label: 'Cash Deposits/Withdrawals',
                headers: [
                    'Operation Number',
                    'Operation Description',
                    'Operation Date',
                    'Payment Date',
                    'Amount',
                    'Currency',
                ],
                rows: data.map((r) => ({
                    'Operation Number': r['Operation Number'],
                    'Operation Description': r['Operation Description'],
                    'Operation Date': r['Operation Date'],
                    'Payment Date': r['Payment Date'],
                    Amount: r.Amount,
                    Currency: r.Currency,
                })),
                confidence: 0.9,
                method: 'orion_cash_deposits_withdrawals',
            });
        }
    }

    // --- Conversion Transactions ---
    const convStartIdx = allTexts.findIndex((t) => /Conversion Transactions/i.test(t));
    if (convStartIdx >= 0) {
        const convEnd = allTexts.findIndex((t) => /Securities Deposits\/Withdrawals/i.test(t));
        const end = convEnd >= 0 ? convEnd : allTexts.length;

        const fxIdx = allTexts.findIndex((t, i) => i >= convStartIdx && /fx\d+/i.test(t));
        if (fxIdx >= 0 && fxIdx < end) {
            const parsed = parseConversionRateAndFxLine(allTexts, fxIdx);
            if (parsed) {
                sections.push({
                    id: 'conversion_transactions',
                    label: 'Conversion Transactions',
                    headers: [
                        'Operation Number',
                        'Operation Date',
                        'Payment Date',
                        'Debited Currency',
                        'Debited Quantity',
                        'Credited Currency',
                        'Credited Quantity',
                        'Rate',
                    ],
                    rows: [parsed],
                    confidence: 0.85,
                    method: 'orion_conversion_transactions',
                });
            }
        }
    }

    return sections;
}

module.exports = {
    extractOrionClientReportTables,
};

