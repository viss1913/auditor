/** Правила «фраза в ячейке → значение новой колонки» для карточки УК (без LLM). */

const DEFAULT_UK_DEAL_TYPE_RULES = [
    { contains: 'Поступление ц/б', value: 'Покупка', strip: true },
    { contains: 'Списание ц/б', value: 'Продажа', strip: true },
    { contains: 'Переоценка', value: 'Переоценка', strip: false },
];

function normalizeContains(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ')
        .trim();
}

function containsPhrase(haystack, needle) {
    const h = normalizeContains(haystack);
    const n = normalizeContains(needle);
    if (!h || !n) return false;
    return h.includes(n);
}

function stripPhrasesFromText(text, phrases = []) {
    let out = String(text ?? '');
    for (const phrase of phrases) {
        const p = String(phrase || '').trim();
        if (!p) continue;
        const re = new RegExp(escapeRegex(p).replace(/\s+/g, '\\s+'), 'gi');
        out = out.replace(re, ' ');
    }
    return out.replace(/\s{2,}/g, ' ').trim();
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} sourceText
 * @param {{ contains: string, value: string, strip?: boolean }[]} rules — первое совпадение
 */
function deriveFromContainsRules(sourceText, rules = []) {
    const text = String(sourceText ?? '').trim();
    if (!text || !rules?.length) {
        return { value: '', stripPhrases: [] };
    }
    for (const rule of rules) {
        const phrase = String(rule.contains || '').trim();
        if (!phrase || !containsPhrase(text, phrase)) continue;
        const stripPhrases = rule.strip !== false ? [phrase] : [];
        return { value: String(rule.value || '').trim(), stripPhrases };
    }
    return { value: '', stripPhrases: [] };
}

/** «если есть Поступление ц/б то Покупка», «Поступление ц/б → Покупка» */
function parseContainsRulesFromMessage(text) {
    const t = String(text || '');
    const rules = [];
    const seen = new Set();

    const push = (contains, value, strip = true) => {
        let c = String(contains || '').trim().replace(/^там\s+есть\s+/i, '');
        let v = String(value || '').trim();
        const placed = v.match(/помест(?:ить|и)\s+["«']?([^"»'.,]+)/i);
        if (placed) v = placed[1].trim();
        if (/колонк/i.test(v) && !/покупк|продаж|переоценк/i.test(v)) return;
        if (!c || !v) return;
        const key = `${normalizeContains(c)}=>${normalizeContains(v)}`;
        if (seen.has(key)) return;
        seen.add(key);
        rules.push({ contains: c, value: v, strip });
    };

    for (const m of t.matchAll(
        /если\s+(?:там\s+)?(?:есть\s+|в\s+[^,]+?\s+есть\s+)?["«']?([^"»'\n,]+?)["»']?\s*(?:то|—|–|-|:)\s*["«']?([^"»'\n,.]+)/gi
    )) {
        push(m[1], m[2], /убер|удал|вычист|очист/i.test(t));
    }

    for (const m of t.matchAll(/["«']?([^"»'\n]+?)["»']?\s*(?:→|->)\s*["«']?([^"»'\n.]+)/gi)) {
        push(m[1], m[2], /убер|удал|вычист|очист/i.test(t));
    }

    for (const m of t.matchAll(/помест(?:ить|и)\s+["«']?([^"»'.]+)["»']?/gi)) {
        const v = m[1].trim();
        if (/покупк/i.test(v) && /поступлен[а-яё]*\s*ц\s*\/?\s*б/i.test(t)) {
            push('Поступление ц/б', v, /убер|удал/i.test(t));
        }
        if (/продаж/i.test(v) && /списан[а-яё]*\s*ц\s*\/?\s*б/i.test(t)) {
            push('Списание ц/б', v, /убер|удал/i.test(t));
        }
    }

    if (/поступлен[а-яё]*\s*ц\s*\/?\s*б/i.test(t) && /покупк/i.test(t)) {
        push('Поступление ц/б', 'Покупка', /убер|удал/i.test(t));
    }
    if (/списан[а-яё]*\s*ц\s*\/?\s*б/i.test(t) && /продаж/i.test(t)) {
        push('Списание ц/б', 'Продажа', /убер|удал/i.test(t));
    }

    return rules;
}

function wantsUkDealTypeColumn(columnName, message) {
    const col = normalizeContains(columnName);
    const msg = normalizeContains(message);
    return col.includes('тип сделк') || (msg.includes('тип сделк') && /operation_type|операц/i.test(msg));
}

function resolveContainsRulesForCommand({ message, newColumnName, fillFromColumn }) {
    const parsed = parseContainsRulesFromMessage(message);
    if (parsed.length) return parsed;
    if (wantsUkDealTypeColumn(newColumnName, message) && fillFromColumn) {
        return DEFAULT_UK_DEAL_TYPE_RULES.map((r) => ({ ...r }));
    }
    return [];
}

module.exports = {
    DEFAULT_UK_DEAL_TYPE_RULES,
    containsPhrase,
    stripPhrasesFromText,
    deriveFromContainsRules,
    parseContainsRulesFromMessage,
    wantsUkDealTypeColumn,
    resolveContainsRulesForCommand,
};
