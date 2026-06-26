/**
 * Эвристика: таблицы из текстового слоя PDF (табы / несколько пробелов).
 */

function splitPdfLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return null;

    if (raw.includes('\t')) {
        const parts = raw.split('\t').map((s) => s.trim()).filter(Boolean);
        return parts.length >= 2 ? parts : null;
    }

    const bySpaces = raw.split(/\s{2,}/).map((s) => s.trim()).filter(Boolean);
    if (bySpaces.length >= 2) return bySpaces;

    if (raw.includes('|')) {
        const parts = raw.split('|').map((s) => s.trim()).filter(Boolean);
        return parts.length >= 2 ? parts : null;
    }

    return null;
}

function isLikelyHeaderCells(cells) {
    if (!cells?.length || cells.length < 2) return false;
    const textish = cells.filter((c) => /[а-яёa-z]/i.test(c) && !/^\d+([.,]\d+)?$/.test(c));
    return textish.length >= Math.max(2, Math.ceil(cells.length * 0.4));
}

function makeHeaderKeys(headers) {
    const used = new Map();
    return headers.map((h, i) => {
        let key = String(h || `col_${i + 1}`)
            .trim()
            .replace(/\s+/g, '_')
            .slice(0, 48);
        if (!key) key = `col_${i + 1}`;
        const n = (used.get(key) || 0) + 1;
        used.set(key, n);
        return n > 1 ? `${key}_${n}` : key;
    });
}

/**
 * @param {string[]} lines
 * @returns {{ ok: boolean, headers: string[], rows: object[], confidence: number, method: string }}
 */
function extractPdfTablesFromLines(lines) {
    const src = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);
    if (src.length < 3) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'none' };
    }

    let best = { headers: [], rows: [], score: 0, start: -1 };

    for (let i = 0; i < src.length; i++) {
        const first = splitPdfLine(src[i]);
        if (!first || first.length < 2) continue;

        const block = [first];
        let j = i + 1;
        while (j < src.length) {
            const cells = splitPdfLine(src[j]);
            if (!cells || cells.length !== first.length) break;
            block.push(cells);
            j++;
        }

        if (block.length < 2) continue;

        const headerRow = isLikelyHeaderCells(block[0]) ? 0 : -1;
        const dataStart = headerRow === 0 ? 1 : 0;
        const dataRows = block.slice(dataStart);
        if (dataRows.length < 2) continue;

        const headers =
            headerRow === 0
                ? block[0].map((h, idx) => String(h || `col_${idx + 1}`).trim())
                : first.map((_, idx) => `col_${idx + 1}`);

        const keys = makeHeaderKeys(headers);
        const rows = dataRows.map((cells) => {
            const row = {};
            for (let c = 0; c < keys.length; c++) {
                const v = cells[c];
                if (v != null && String(v).trim() !== '') row[keys[c]] = String(v).trim();
            }
            return Object.keys(row).length ? row : null;
        }).filter(Boolean);

        const score = rows.length * headers.length + (headerRow === 0 ? 5 : 0);
        if (score > best.score) {
            best = { headers: keys, rows, score, start: i };
        }
        i = j - 1;
    }

    if (!best.rows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'delimiter_scan' };
    }

    const confidence = Math.min(0.85, 0.45 + Math.min(best.rows.length, 20) * 0.02);
    return {
        ok: true,
        headers: best.headers,
        rows: best.rows,
        confidence,
        method: 'delimiter_scan',
    };
}

module.exports = { extractPdfTablesFromLines, splitPdfLine };
