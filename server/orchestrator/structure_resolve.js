const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function letterToIndex(letter) {
    const u = String(letter || '').toUpperCase().trim();
    if (!u) return null;
    if (u.length === 1) return COL_LETTERS.indexOf(u);
    return null;
}

/**
 * Разбор ответа аудитора про структуру (лист, колонка, профиль).
 */
function extractFilePrefixFromText(userText) {
    const raw = String(userText || '');
    const patterns = [
        /префикс\s+([A-Za-z0-9_]+)/i,
        /(?:начина(?:ются|ется)|starts?\s+with)\s+(?:с\s+)?["']?([A-Za-z0-9_]+)/i,
        /(?:только\s+)?файл[аы]?\s+(?:которые\s+)?начина(?:ются|ется)\s+с\s+["']?([A-Za-z0-9_]+)/i,
        /возьми\s+(?:плиз\s+)?(?:только\s+)?файл[аы]?\s+(?:которые\s+)?начина(?:ются|ется)\s+с\s+["']?([A-Za-z0-9_]+)/i,
        /(?:возьми|бер[ие])\s+(?:плиз\s+)?(?:только\s+)?(?:файл[аы]?\s+)?(?:которые\s+)?начина(?:ются|ется)\s+с\s+["']?([A-Za-z0-9_]+)/i,
    ];
    for (const re of patterns) {
        const m = raw.match(re);
        if (m?.[1]) {
            const p = m[1];
            return p.endsWith('_') ? p : `${p}_`;
        }
    }
    return null;
}

function resolveStructureFromMessage(userText, layoutMeta) {
    const raw = String(userText || '');
    const t = raw.toLowerCase();
    if (!t) return {};

    const out = {};

    const sheetMatch =
        t.match(/лист[:\s]+["']?([^"'\n]+)/i) ||
        (layoutMeta?.sheetNames || []).find((s) => t.includes(String(s).toLowerCase()));
    if (sheetMatch) {
        const name = typeof sheetMatch === 'string' ? sheetMatch : sheetMatch[1]?.trim();
        if (name && (layoutMeta?.sheetNames || []).some((s) => s.toLowerCase() === name.toLowerCase())) {
            out.sheetName = (layoutMeta.sheetNames || []).find(
                (s) => s.toLowerCase() === name.toLowerCase()
            );
        }
    }
    for (const s of layoutMeta?.sheetNames || []) {
        if (t.includes(String(s).toLowerCase())) {
            out.sheetName = s;
            break;
        }
    }

    const colLetter = t.match(/колонк[аеиу]?\s*([a-dвгб])/i) || t.match(/\b([a-d])\b/i);
    if (colLetter) {
        const idx = letterToIndex(colLetter[1].replace(/в/gi, 'b').replace(/г/gi, 'g'));
        if (idx >= 0) out.nameColumn = idx;
    }
    if (/колонк[аеи]?\s*0|column\s*0/i.test(t)) out.nameColumn = 0;
    if (/колонк[аеи]?\s*1|column\s*1/i.test(t)) out.nameColumn = 1;

    if (/депо|выписк|движени.*ценн|pdf/i.test(t)) out.scenarioId = 'opif_depo';
    if (/брокер|1\.2\.|1f018/i.test(t)) out.scenarioId = 'opif_broker';

    const filePrefix = extractFilePrefixFromText(raw);
    if (filePrefix) out.filePrefix = filePrefix;

    if (/ук|карточк|58\.01|ценн/i.test(t)) out.profileId = 'uk_card';
    if (/только\s+сделк|сверк|брокер|только\s+76|58\.01.*76/i.test(t)) out.ukMode = 'trades';
    if (/полн.*карточк|все\s+проводк|переоценк/i.test(t)) out.ukMode = 'full';
    if (/08|осв|оборотно/i.test(t)) out.profileId = 'os_08';
    if (/01|амортизац|ведомост/i.test(t)) out.profileId = 'os_01';

    if (/количеств.*\s*i\b|колонк[аеи]\s*i\b/i.test(t)) out.quantityColumn = 8;
    if (/количеств.*\s*h\b|сумм.*\s*h\b/i.test(t)) out.amountColumn = 7;

    return out;
}

module.exports = { resolveStructureFromMessage, letterToIndex, extractFilePrefixFromText };
