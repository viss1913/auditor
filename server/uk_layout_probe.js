const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const UK_DATE_RE = /^\d{2}\.\d{2}\.\d{4}/;

function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

function colLetter(index) {
    if (index < 26) return COL_LETTERS[index];
    return COL_LETTERS[Math.floor(index / 26) - 1] + COL_LETTERS[index % 26];
}

function parseNum(val) {
    const s = String(val ?? '')
        .replace(/\s/g, '')
        .replace(/\u00A0/g, '')
        .replace(',', '.');
    if (!s || s === '-') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function median(nums) {
    if (!nums.length) return null;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function scoreColumnByPattern(data, startRow, scanEnd, col, pattern) {
    let count = 0;
    for (let i = startRow; i < scanEnd; i++) {
        const v = cellText(data[i], col);
        if (pattern.test(v)) count++;
    }
    return count;
}

const UK_ACCOUNT_PREFIXES = new Set([
    50, 51, 52, 55, 57, 58, 60, 62, 66, 67, 68, 69, 76, 90, 91,
]);

function looksLikeAccountCell(raw) {
    const s = String(raw ?? '').trim();
    if (!/^\d{2}\.\d{2}(\.\d+)?$/.test(s)) return false;
    const prefix = parseInt(s.split('.')[0], 10);
    return UK_ACCOUNT_PREFIXES.has(prefix);
}

/** Шапка 1С: отдельные «Аналитика Дт/Кт», строка данных после подзаголовков. */
function detectUkHeaderMeta(data, maxRows = 16) {
    let dualAnalytics = false;
    let analyticsDtCol = null;
    let analyticsKtCol = null;
    let indicatorCol = null;
    let dataStartRow = null;

    for (let i = 0; i < Math.min(maxRows, data?.length || 0); i++) {
        const row = data[i] || [];
        for (let c = 0; c < row.length; c++) {
            const t = cellText(row, c).toLowerCase();
            if (/аналитик.*дт/i.test(t)) analyticsDtCol = c;
            if (/аналитик.*кт/i.test(t)) analyticsKtCol = c;
            if (t === 'показатель') indicatorCol = c;
        }
        const joined = row.map((_, ci) => cellText(row, ci)).join(' ');
        if (/период/i.test(joined) && /показатель/i.test(joined) && /дебет/i.test(joined)) {
            dataStartRow = i + 2;
        }
    }
    dualAnalytics =
        analyticsDtCol != null &&
        analyticsKtCol != null &&
        analyticsKtCol > analyticsDtCol;

    return { dualAnalytics, analyticsDtCol, analyticsKtCol, indicatorCol, dataStartRow };
}

function probePeriodColumn(data, startRow, scanEnd) {
    let best = { column: 0, count: 0 };
    for (let c = 0; c < 4; c++) {
        const count = scoreColumnByPattern(data, startRow, scanEnd, c, UK_DATE_RE);
        if (count > best.count) best = { column: c, count };
    }
    return best;
}

function probeDebitAccountColumn(data, startRow, scanEnd) {
    let best = { column: 6, count: 0 };
    for (let c = 4; c < 12; c++) {
        const count = scoreColumnByPattern(data, startRow, scanEnd, c, /^58\.01/);
        if (count > best.count) best = { column: c, count };
    }
    return best;
}

function probeCreditAccountColumn(data, startRow, scanEnd, debitCol) {
    let best = { column: 9, count: 0 };
    for (let c = debitCol + 1; c < 14; c++) {
        let count = 0;
        for (let i = startRow; i < scanEnd; i++) {
            const row = data[i] || [];
            if (!/^58\.01/.test(cellText(row, debitCol))) continue;
            const cr = cellText(row, c);
            if (/^76/.test(cr) || /^91/.test(cr)) count++;
        }
        if (count > best.count) best = { column: c, count };
    }
    return best;
}

function probeDocumentColumn(data, startRow, scanEnd, periodCol) {
    let best = { column: 1, count: 0 };
    for (let c = periodCol + 1; c < 6; c++) {
        let count = 0;
        for (let i = startRow; i < scanEnd; i++) {
            const row = data[i] || [];
            if (!UK_DATE_RE.test(cellText(row, periodCol))) continue;
            if (cellText(row, c).length >= 3) count++;
        }
        if (count > best.count) best = { column: c, count };
    }
    return best;
}

function probeAnalyticsColumn(data, startRow, scanEnd, periodCol, documentCol) {
    let best = { column: 3, count: 0 };
    for (let c = documentCol + 1; c < 8; c++) {
        let count = 0;
        for (let i = startRow; i < scanEnd; i++) {
            const row = data[i] || [];
            if (!UK_DATE_RE.test(cellText(row, periodCol))) continue;
            const v = cellText(row, c);
            if (/^сделка\s+с\s+ц/i.test(v)) continue;
            if (v.length >= 8 || /\d{5,}/.test(v)) count++;
        }
        if (count > best.count) best = { column: c, count };
    }
    return best;
}

function probeBalanceColumns(data, startRow, indicatorCol, quantityCol) {
    for (let i = 0; i < Math.min(startRow, 12); i++) {
        const row = data[i] || [];
        for (let c = 0; c < row.length; c++) {
            if (!/текущее\s*сальдо/i.test(cellText(row, c))) continue;
            const sub = String((data[i + 1] || [])[c] || '').toLowerCase();
            if (/сумма/.test(sub)) {
                return { balance_side_column: c, balance_column: c };
            }
            return { balance_side_column: c, balance_column: c + 1 };
        }
    }

    const scanEnd = Math.min(data?.length || 0, startRow + 250);
    const scores = {};
    for (let i = startRow; i < scanEnd; i++) {
        const row = data[i] || [];
        if (cellText(row, indicatorCol) !== 'Кол.') continue;
        for (let c = 8; c < Math.min(row.length, 14); c++) {
            if (c === quantityCol) continue;
            const n = parseNum(row[c]);
            if (n == null || n < 1000) continue;
            scores[c] = (scores[c] || 0) + 1;
        }
    }
    const ranked = Object.entries(scores)
        .map(([idx, count]) => ({ column: Number(idx), count }))
        .sort((a, b) => b.count - a.count);
    if (ranked[0]) {
        const col = ranked[0].column;
        return { balance_side_column: col > 0 ? col - 1 : col, balance_column: col };
    }
    return { balance_side_column: 10, balance_column: 11 };
}

function probeAmountColumn(data, startRow, scanEnd, indicatorCol, debitCol, creditColHint = null) {
    const numsByCol = {};
    const accountLikeByCol = {};
    const maxCol = creditColHint != null ? creditColHint : debitCol + 4;
    for (let i = startRow; i < scanEnd; i++) {
        const row = data[i] || [];
        if (cellText(row, indicatorCol) !== 'БУ') continue;
        if (!/^58\.01/.test(cellText(row, debitCol))) continue;
        for (let c = debitCol + 1; c <= maxCol; c++) {
            if (c === creditColHint) continue;
            const raw = cellText(row, c);
            const n = parseNum(row[c]);
            if (n == null) continue;
            if (!numsByCol[c]) numsByCol[c] = [];
            numsByCol[c].push(n);
            if (looksLikeAccountCell(raw)) {
                accountLikeByCol[c] = (accountLikeByCol[c] || 0) + 1;
            }
        }
    }
    const scored = Object.entries(numsByCol).map(([idx, values]) => {
        const col = Number(idx);
        const med = median(values) ?? 0;
        const max = Math.max(...values);
        let score = values.length;
        if (med > 1_000_000 || max > 10_000_000) score -= 1000;
        if (col === debitCol + 1) score += 25;
        if (col === 7) score += 5;
        const acct = accountLikeByCol[col] || 0;
        if (acct > values.length * 0.08) score -= 2000;
        if (looksLikeAccountCell(values[0])) score -= 2000;
        return { column: col, score, median: med };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || { column: debitCol + 1, score: 0 };
}

function finalizeUkColumnRoles({
    headerMeta,
    debitAccountColumn,
    amountColumn,
    creditAccountColumn,
    previewRows,
}) {
    let amount = amountColumn;
    let credit = creditAccountColumn;

    if (headerMeta.dualAnalytics) {
        amount = debitAccountColumn + 1;
    } else if (amount === credit) {
        amount = debitAccountColumn + 1;
    }

    for (const pr of previewRows || []) {
        if (looksLikeAccountCell(pr.amount)) {
            amount = debitAccountColumn + 1;
            break;
        }
    }

    if (credit <= amount) {
        credit = amount + (headerMeta.dualAnalytics ? 2 : 1);
    }

    return { amountColumn: amount, creditAccountColumn: credit };
}

/** Варианты колонок для uk_card без LLM (dual analytics vs mechel с сальдо в col 8). */
function buildUkColumnVariants(probe = {}) {
    const debit = probe.debit_account_column ?? 6;
    const seen = new Set();
    const out = [];

    const add = (amount, credit, variant) => {
        const key = `${amount}:${credit}`;
        if (seen.has(key) || amount < 0 || credit <= amount) return;
        seen.add(key);
        out.push({
            amount_column: amount,
            credit_account_column: credit,
            quantity_column: amount,
            variant,
        });
    };

    if (probe.dual_analytics) {
        add(debit + 1, debit + 3, 'dual_analytics_wide');
        add(debit + 1, debit + 2, 'dual_analytics_compact');
    }
    add(debit + 1, debit + 3, 'mechel_balance_inline');
    if (probe.amount_column != null && probe.credit_account_column != null) {
        add(probe.amount_column, probe.credit_account_column, 'probed');
    }
    add(7, 8, 'fallback_dual');
    add(7, 9, 'fallback_mechel');
    return out;
}

function layoutMetaWithUkColumns(layoutMeta, cols) {
    const uk_probe = { ...(layoutMeta.uk_probe || {}), ...cols };
    return { ...layoutMeta, uk_probe };
}

/**
 * Balance-aware probe всех ролей колонок по семантике данных.
 * @param {Array<Array>} data
 * @param {{ data_start_row?: number, indicator_column?: number }} opts
 */
function probeUkLayout(data, opts = {}) {
    const headerMeta = detectUkHeaderMeta(data);
    let startRow = opts.data_start_row ?? opts.skip_rows ?? headerMeta.dataStartRow ?? 7;
    const scanEnd = Math.min(data?.length || 0, startRow + 250);

    const periodProbe = probePeriodColumn(data, startRow, scanEnd);
    const periodColumn = periodProbe.column;

    const indicatorCounts = {};
    for (let i = startRow; i < scanEnd; i++) {
        const row = data[i] || [];
        for (let c = 0; c < Math.min(row.length, 12); c++) {
            const v = cellText(row, c);
            if (v === 'БУ' || v === 'Кол.') indicatorCounts[c] = (indicatorCounts[c] || 0) + 1;
        }
    }
    const rankedInd = Object.entries(indicatorCounts)
        .map(([idx, count]) => ({ index: Number(idx), count }))
        .sort((a, b) => b.count - a.count);
    const indicatorColumn =
        opts.indicator_column ?? headerMeta.indicatorCol ?? rankedInd[0]?.index ?? 5;

    const debitProbe = probeDebitAccountColumn(data, startRow, scanEnd);
    const debitAccountColumn = debitProbe.column;

    const creditProbe = probeCreditAccountColumn(data, startRow, scanEnd, debitAccountColumn);
    let creditAccountColumn = creditProbe.column;

    const documentProbe = probeDocumentColumn(data, startRow, scanEnd, periodColumn);
    const documentColumn = documentProbe.count > 0 ? documentProbe.column : 1;

    const analyticsColumn =
        headerMeta.analyticsDtCol != null
            ? headerMeta.analyticsDtCol
            : (() => {
                  const analyticsProbe = probeAnalyticsColumn(
                      data,
                      startRow,
                      scanEnd,
                      periodColumn,
                      documentColumn
                  );
                  return analyticsProbe.count > 0 ? analyticsProbe.column : 3;
              })();

    const amountProbe = probeAmountColumn(
        data,
        startRow,
        scanEnd,
        indicatorColumn,
        debitAccountColumn,
        headerMeta.dualAnalytics ? debitAccountColumn + 2 : creditAccountColumn
    );
    let amountColumn = amountProbe.column ?? debitAccountColumn + 1;

    const balanceProbe = probeBalanceColumns(data, startRow, indicatorColumn, amountColumn);

    const qtyByCol = {};
    const qtySamples = {};
    let hasCredit76 = false;
    let hasCredit91 = false;

    for (let i = startRow; i < scanEnd; i++) {
        const row = data[i] || [];
        const pokazatel = cellText(row, indicatorColumn);
        const dbAcc = cellText(row, debitAccountColumn);
        const crAcc = cellText(row, creditAccountColumn);

        if (/^58\.01/.test(dbAcc)) {
            if (/^76/.test(crAcc)) hasCredit76 = true;
            if (/^91/.test(crAcc)) hasCredit91 = true;
        }

        if (pokazatel !== 'Кол.') continue;

        for (let c = debitAccountColumn; c <= creditAccountColumn + 1; c++) {
            const n = parseNum(row[c]);
            if (n == null) continue;
            if (!qtyByCol[c]) qtyByCol[c] = [];
            qtyByCol[c].push(n);
            if (!qtySamples[c]) qtySamples[c] = String(row[c]);
        }
    }

    const scored = Object.entries(qtyByCol).map(([idx, values]) => {
        const col = Number(idx);
        const med = median(values) ?? 0;
        const max = Math.max(...values);
        let score = values.length;
        if (med > 1_000_000 || max > 10_000_000) score -= 1000;
        if (med > 100_000) score -= 100;
        if (col === amountColumn) score += 15;
        return {
            index: col,
            letter: colLetter(col),
            count: values.length,
            median: med,
            max,
            score,
            sample: qtySamples[col] || '',
        };
    });
    scored.sort((a, b) => b.score - a.score);

    let quantityColumn = amountColumn;
    let ambiguous = false;
    let options = [
        { index: amountColumn, letter: colLetter(amountColumn), sample: '' },
        { index: amountColumn + 1, letter: colLetter(amountColumn + 1), sample: '' },
    ];

    if (scored.length) {
        const top = scored[0];
        const second = scored[1];
        quantityColumn = top.index;
        options = scored.slice(0, 3).map((s) => ({
            index: s.index,
            letter: s.letter,
            sample: s.sample,
            median: s.median,
        }));
        ambiguous = Boolean(second) && top.score - second.score <= 5;
    }

    const tentativePreview = [];
    for (let i = startRow; i < scanEnd && tentativePreview.length < 3; i++) {
        const row = data[i] || [];
        if (!UK_DATE_RE.test(cellText(row, periodColumn))) continue;
        if (cellText(row, indicatorColumn) !== 'БУ') continue;
        if (!/^58\.01/.test(cellText(row, debitAccountColumn))) continue;
        tentativePreview.push({ amount: cellText(row, amountColumn) });
    }

    const finalized = finalizeUkColumnRoles({
        headerMeta,
        debitAccountColumn,
        amountColumn,
        creditAccountColumn,
        previewRows: tentativePreview,
    });
    amountColumn = finalized.amountColumn;
    creditAccountColumn = finalized.creditAccountColumn;

    const previewRows = [];
    for (let i = startRow; i < scanEnd && previewRows.length < 3; i++) {
        const row = data[i] || [];
        if (!UK_DATE_RE.test(cellText(row, periodColumn))) continue;
        if (cellText(row, indicatorColumn) !== 'БУ') continue;
        if (!/^58\.01/.test(cellText(row, debitAccountColumn))) continue;
        previewRows.push({
            period: cellText(row, periodColumn),
            document: cellText(row, documentColumn).slice(0, 80),
            amount: cellText(row, amountColumn),
            credit: cellText(row, creditAccountColumn),
        });
    }

    return {
        period_column: periodColumn,
        document_column: documentColumn,
        analytics_column: analyticsColumn,
        analytics_dt_column: headerMeta.analyticsDtCol,
        analytics_kt_column: headerMeta.analyticsKtCol,
        dual_analytics: headerMeta.dualAnalytics,
        indicator_column: indicatorColumn,
        debit_account_column: debitAccountColumn,
        amount_column: amountColumn,
        credit_account_column: creditAccountColumn,
        quantity_column: quantityColumn,
        balance_column: balanceProbe.balance_column,
        balance_side_column: balanceProbe.balance_side_column,
        quantity_ambiguous: ambiguous,
        quantity_options: options,
        has_credit_76: hasCredit76,
        has_credit_91: hasCredit91,
        has_document_column: documentProbe.count > 0,
        skip_rows: startRow,
        preview_rows: previewRows,
        mode: 'full',
    };
}

module.exports = {
    probeUkLayout,
    buildUkColumnVariants,
    layoutMetaWithUkColumns,
    detectUkHeaderMeta,
    looksLikeAccountCell,
    parseNum,
    median,
    colLetter,
    UK_DATE_RE,
};
