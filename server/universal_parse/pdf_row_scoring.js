const ISIN_RE = /\b[A-Z]{2}[A-Z0-9]{9}\d\b/i;
const DATE_RE = /\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b/;
const QTY_RE = /\b-?\d[\d\s,.]*\b/;

/**
 * Оценка строки как data-row (0..1).
 * @param {{ text?: string, items?: Array<{ text?: string }> }} row
 */
function scoreDataRow(row) {
    const text = String(row?.text || '').trim();
    if (!text || text.length < 2) return 0;

    let score = 0;
    if (ISIN_RE.test(text)) score += 0.45;
    if (DATE_RE.test(text)) score += 0.2;
    const nums = (text.match(QTY_RE) || []).length;
    if (nums >= 1) score += 0.15;
    if (nums >= 2) score += 0.1;
    if (/^[A-Z]{2,}[-–][A-Z]{2,}/.test(text)) score += 0.15;
    if (/(?:шт|м|кг|л)\b/i.test(text) && nums >= 1) score += 0.1;

    const tokens = text.split(/\s+/).filter(Boolean);
    if (tokens.length >= 3 && tokens.length <= 12) score += 0.05;

    return Math.min(1, score);
}

/**
 * Индекс первой строки данных по scoring (устойчивее regex-only).
 * @param {Array<{ text?: string }>} clusteredRows
 * @param {object} [opts]
 */
function suggestDataStartByScoring(clusteredRows = [], opts = {}) {
    const minRun = opts.minRun ?? 2;
    const minScore = opts.minScore ?? 0.35;
    if (!clusteredRows.length) return 0;

    const scores = clusteredRows.map((r) => scoreDataRow(r));

    for (let i = 0; i <= clusteredRows.length - minRun; i++) {
        let ok = true;
        for (let j = 0; j < minRun; j++) {
            if (scores[i + j] < minScore) {
                ok = false;
                break;
            }
        }
        if (ok) return i;
    }

    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < scores.length; i++) {
        if (scores[i] > bestScore) {
            bestScore = scores[i];
            bestIdx = i;
        }
    }
    if (bestScore >= minScore) return bestIdx;

    return Math.min(1, clusteredRows.length - 1);
}

module.exports = {
    scoreDataRow,
    suggestDataStartByScoring,
    ISIN_RE,
};
