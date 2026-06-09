const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

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

/**
 * Balance-aware: на «Кол.» не брать колонку с огромными числами (текущее сальдо).
 * @param {Array<Array>} data
 * @param {{ data_start_row?: number, indicator_column?: number }} opts
 */
function probeUkLayout(data, opts = {}) {
    const startRow = opts.data_start_row ?? opts.skip_rows ?? 7;
    const scanEnd = Math.min(data?.length || 0, startRow + 250);

    let indicatorColumn = opts.indicator_column ?? 5;
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
    if (rankedInd[0]) indicatorColumn = rankedInd[0].index;

    const amountColumn = opts.amount_column ?? 7;
    const qtyByCol = {};
    const qtySamples = {};
    let hasCredit76 = false;
    let hasCredit91 = false;
    let hasDocumentColumn = false;
    let documentColumn = 1;

    const headerScanEnd = Math.min(data.length, startRow + 2);
    for (let i = 0; i < headerScanEnd; i++) {
        const row = data[i] || [];
        row.forEach((cell, idx) => {
            if (/^документ$/i.test(cellText(row, idx))) {
                hasDocumentColumn = true;
                documentColumn = idx;
            }
        });
    }

    for (let i = startRow; i < scanEnd; i++) {
        const row = data[i] || [];
        const firstCol = cellText(row, 0);
        const pokazatel = cellText(row, indicatorColumn);
        const dbAcc = cellText(row, 6);
        const crAcc = cellText(row, 9);

        if (/^58\.01/.test(dbAcc)) {
            if (/^76/.test(crAcc)) hasCredit76 = true;
            if (/^91/.test(crAcc)) hasCredit91 = true;
        }

        if (pokazatel !== 'Кол.') continue;

        for (let c = 6; c <= 10; c++) {
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
        if (col === amountColumn + 1) score -= 5;
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

    let suggested = amountColumn;
    let ambiguous = false;
    let options = [
        { index: 7, letter: 'H', sample: '' },
        { index: 8, letter: 'I', sample: '' },
    ];

    if (scored.length) {
        const top = scored[0];
        const second = scored[1];
        suggested = top.index;
        options = scored.slice(0, 3).map((s) => ({
            index: s.index,
            letter: s.letter,
            sample: s.sample,
            median: s.median,
        }));
        ambiguous = Boolean(second) && top.score - second.score <= 5;
    }

    const previewRows = [];
    for (let i = startRow; i < scanEnd && previewRows.length < 3; i++) {
        const row = data[i] || [];
        if (!/^\d{2}\.\d{2}\.\d{4}/.test(cellText(row, 0))) continue;
        if (cellText(row, indicatorColumn) !== 'БУ') continue;
        if (!/^58\.01/.test(cellText(row, 6))) continue;
        previewRows.push({
            period: cellText(row, 0),
            document: cellText(row, documentColumn).slice(0, 80),
            amount: cellText(row, amountColumn),
            credit: cellText(row, 9),
        });
    }

    return {
        indicator_column: indicatorColumn,
        quantity_column: suggested,
        amount_column: amountColumn,
        quantity_ambiguous: ambiguous,
        quantity_options: options,
        has_credit_76: hasCredit76,
        has_credit_91: hasCredit91,
        has_document_column: hasDocumentColumn,
        document_column: documentColumn,
        skip_rows: startRow,
        preview_rows: previewRows,
        mode: 'full',
    };
}

module.exports = { probeUkLayout, parseNum, median, colLetter };
