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
        /(?:только\s+)?файл[аов]*\s+(?:которые\s+)?(?:названи[яе]\s+)?начина(?:ются|ется)\s+с\s+["']?([A-Za-z0-9_]+)/i,
        /возьми\s+(?:плиз\s+)?(?:только\s+)?файл[аов]*\s+(?:которые\s+)?(?:названи[яе]\s+)?начина(?:ются|ется)\s+с\s+["']?([A-Za-z0-9_]+)/i,
        /(?:возьми|бер[ие])\s+(?:плиз\s+)?(?:только\s+)?(?:файл[аов]*\s+)?(?:которые\s+)?(?:названи[яе]\s+)?начина(?:ются|ется)\s+с\s+["']?([A-Za-z0-9_]+)/i,
        /\b(1[fF]\d{3})[_]?\b/,
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

/** Секция брокерского Excel: 1.1 прекращённые / 1.2 неисполненные. null — дефолт 1.2. */
function extractBrokerSectionFromText(userText) {
    const raw = String(userText || '');
    const t = raw.toLowerCase();
    if (!t) return null;

    const has11 = /\b1\s*[\.\-]\s*1\b/.test(t) || /раздел\s*1\.1/i.test(t);
    const has12 = /\b1\s*[\.\-]\s*2\b/.test(t) || /раздел\s*1\.2/i.test(t);
    const notFulfilled =
        /не\s+исполн|неисполнен/i.test(t) ||
        /обязательств\w*\s+из\s+которых\s+не/i.test(t) ||
        /ожида\w*\s+исполн/i.test(t) ||
        /открыт\w*\s+обязательств/i.test(t);
    const terminated =
        /прекращ/i.test(t) ||
        /обязательств\w*\s+из\s+которых\s+прекращ/i.test(t) ||
        /закрыт\w*\s+сделк/i.test(t) ||
        /терминир/i.test(t) ||
        (/исполнен/i.test(t) && /на\s+(?:отчетн|дату)/i.test(t) && !/не\s*исполн/i.test(t));

    if (has12 && !has11) return '1.2';
    if (has11 && !has12) return '1.1';
    if (notFulfilled && !terminated) return '1.2';
    if (terminated && !notFulfilled) return '1.1';
    if (has12 && has11) {
        return t.lastIndexOf('1.2') > t.lastIndexOf('1.1') ? '1.2' : '1.1';
    }

    return null;
}

function brokerSectionLabel(sectionId) {
    if (sectionId === '1.1') {
        return '1.1 — сделки, обязательства из которых прекращены';
    }
    return '1.2 — сделки, обязательства из которых не исполнены';
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

    if (/депо|выписк|движени.*ценн/i.test(t)) out.scenarioId = 'opif_depo';
    if (/брокерск|отчет\s+брокер|aton|атон|client_\d+.*_to_/i.test(t)) out.scenarioId = 'broker_pdf';
    else if (
        /брокер|1\.[12]\.|1f\d{3}|репо|сделк.*обязательств|спарс.*1f|данн.*1f/i.test(t)
    ) {
        out.scenarioId = 'opif_broker';
    }

    const filePrefix = extractFilePrefixFromText(raw);
    if (filePrefix) out.filePrefix = filePrefix;

    const brokerSection = extractBrokerSectionFromText(raw);
    if (brokerSection) out.brokerSection = brokerSection;

    if (/ук|карточк|58\.01|ценн/i.test(t)) out.profileId = 'uk_card';
    if (/только\s+сделк|сверк|брокер|только\s+76|58\.01.*76/i.test(t)) out.ukMode = 'trades';
    if (/полн.*карточк|все\s+проводк|переоценк/i.test(t)) out.ukMode = 'full';
    if (/08|осв|оборотно/i.test(t)) out.profileId = 'os_08';
    if (/01|амортизац|ведомост/i.test(t)) out.profileId = 'os_01';

    if (/количеств.*\s*i\b|колонк[аеи]\s*i\b/i.test(t)) out.quantityColumn = 8;
    if (/количеств.*\s*h\b|сумм.*\s*h\b/i.test(t)) out.amountColumn = 7;

    return out;
}

module.exports = {
    resolveStructureFromMessage,
    letterToIndex,
    extractFilePrefixFromText,
    extractBrokerSectionFromText,
    brokerSectionLabel,
};
