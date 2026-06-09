const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

function colLetter(index) {
    if (index < 26) return COL_LETTERS[index];
    return COL_LETTERS[Math.floor(index / 26) - 1] + COL_LETTERS[index % 26];
}

function looksNumeric(val) {
    const s = String(val || '').replace(/\s/g, '').replace(',', '.');
    return /^-?\d/.test(s);
}

/**
 * На строках «Кол.» ищем колонку с количеством (часто I=8, если H=7 пуст на Кол.)
 * @param {Array[]} data
 * @param {{ indicator_column?: number, data_start_row?: number }} opts
 */
function detectUkQuantityColumn(data, opts = {}) {
    const indicatorCol = opts.indicator_column ?? 5;
    const startRow = opts.data_start_row ?? 7;
    const hits = {};

    for (let i = startRow; i < Math.min(data.length, startRow + 120); i++) {
        const row = data[i];
        if (String(row[indicatorCol] || '').trim() !== 'Кол.') continue;
        for (let c = 6; c <= 10; c++) {
            if (looksNumeric(row[c])) {
                hits[c] = (hits[c] || 0) + 1;
            }
        }
    }

    const ranked = Object.entries(hits)
        .map(([idx, count]) => ({
            index: Number(idx),
            letter: colLetter(Number(idx)),
            count,
        }))
        .sort((a, b) => b.count - a.count);

    if (ranked.length === 0) {
        return { suggested: 7, ambiguous: false, options: [{ index: 7, letter: 'H' }, { index: 8, letter: 'I' }] };
    }

    const top = ranked[0];
    const second = ranked[1];
    const ambiguous = second && top.count - second.count <= 2;

    return {
        suggested: top.index,
        ambiguous,
        options: ranked.slice(0, 3),
    };
}

module.exports = { detectUkQuantityColumn };
