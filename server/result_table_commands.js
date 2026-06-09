const { parseFilterIntent } = require('./table_row_filter');

function addReplaceMapping(mappings, seen, from, to) {
    const f = String(from || '').trim();
    const t = String(to || '').trim();
    if (!f || !t) return;
    const key = `${f}=>${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    mappings.push({ from: f, to: t });
}

function parseReplaceIntent(text, headers = []) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (!/замен|подмен|replace/i.test(raw)) return null;

    let column =
        extractColumnFromMessage(raw, headers) ||
        resolveColumnHint(
            (raw.match(/\b(operationtype|operation_type|operation type)\b/i) || [])[1] || '',
            headers
        );

    if (!column && (headers || []).includes('operationType')) column = 'operationType';

    const mappings = [];
    const seen = new Set();

    const ruleParts = raw.split(/(?=\s*если\s+)/i).filter((p) => /если/i.test(p));
    for (const part of ruleParts) {
        const m = part.match(
            /если\s+["«']?([^"»'\n.]+?)["»']?\s+то\s+(?:замени\s+на\s+)?["«']?([^"»'\n.]+)/i
        );
        if (m) addReplaceMapping(mappings, seen, m[1], m[2]);
    }

    for (const m of raw.matchAll(
        /["«']?([^"»'\n]+?)["»']?\s*(?:→|->|—)\s*["«']?([^"»'\n.]+)/gi
    )) {
        addReplaceMapping(mappings, seen, m[1], m[2]);
    }

    if (/списан/i.test(raw)) addReplaceMapping(mappings, seen, 'Списание ЦБ', 'продажа');
    if (/покупк|зачисл|попкук/i.test(raw)) {
        addReplaceMapping(mappings, seen, 'Покупка ЦБ', 'покупка');
        addReplaceMapping(mappings, seen, 'Зачисление ЦБ', 'покупка');
    }

    if (!mappings.length) return null;

    return {
        action: 'replace_values',
        column,
        mappings,
        planner: 'regex',
    };
}

function normalizeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9]+/g, ' ')
        .trim();
}

function resolveColumnHint(hint, headers) {
    const requestedNorm = normalizeText(hint);
    if (!requestedNorm || !headers?.length) return null;

    const headerNorms = headers.map((h) => ({ header: h, norm: normalizeText(h) }));
    let hit =
        headerNorms.find((x) => x.norm === requestedNorm)?.header ||
        headerNorms.find((x) => requestedNorm && x.norm.includes(requestedNorm))?.header ||
        headerNorms.find((x) => requestedNorm && requestedNorm.includes(x.norm))?.header;

    if (!hit) {
        const aliasMap = {
            группа: 'Группа',
            подразделение: 'Подразделение',
            ос: 'ОС',
            год: 'Год',
            тип: 'тип',
            наименование: 'ОС',
        };
        const alias = aliasMap[requestedNorm];
        if (alias) hit = headerNorms.find((x) => x.norm === normalizeText(alias))?.header;
    }
    return hit || null;
}

function extractColumnFromMessage(text, headers) {
    const patterns = [
        /(?:колонк[ауеи]\s+|в\s+колонке\s+|по\s+колонке\s+)["«']?([^"»'\n,.]+)/i,
        /(?:из|в)\s+колонк[ауеи]\s+["«']?([^"»'\n,.]+)/i,
        /(?:из\s+колонки\s+)["«']?([^"»'\n,.]+)/i,
        /(?:каждой\s+ячейк[еи]\s+колонки\s+)["«']?([^"»'\n,.]+)/i,
    ];
    for (const re of patterns) {
        const m = text.match(re);
        if (m?.[1]) {
            const col = resolveColumnHint(m[1].trim(), headers);
            if (col) return col;
        }
    }

    for (const h of headers || []) {
        const hn = normalizeText(h);
        if (hn.length >= 2 && normalizeText(text).includes(hn)) return h;
    }
    return null;
}

function extractAuditorRule(text, action) {
    const t = String(text || '').trim();
    const colonIdx = t.indexOf(':');
    if (colonIdx >= 0) {
        const after = t.slice(colonIdx + 1).trim();
        if (after) return after;
    }

    let rule = t
        .replace(
            /^(?:проанализируй|проанализируйте|определи|определите|классифицируй|классифицируйте|подумай|подумайте|отправь\s+на\s+анализ|разбери)\s*/i,
            ''
        )
        .replace(/^(?:в|по)\s+колонк[ауеи]\s+[^,.]+[,.]?\s*/i, '')
        .replace(/^колонк[ауеи]\s+[^,.]+[,.]?\s*/i, '')
        .trim();

    if (action === 'classify' && !rule) {
        rule =
            'Определи: аренда (rent), ремонт (repair), движимое (movable), недвижимое (real_estate), прочее (other). Если неясно — not_sure.';
    }
    return rule;
}

/**
 * Разбор команды аудитора для режима результата (без LLM).
 */
function parseResultTableCommand(text, headers = []) {
    const t = String(text || '').trim();
    if (!t) return { action: null };

    const replaceCmd = parseReplaceIntent(t, headers);
    if (replaceCmd?.action === 'replace_values' && replaceCmd.mappings?.length) {
        return replaceCmd;
    }

    const filterCmd = parseFilterIntent(t, headers);
    if (filterCmd.action === 'filter_rows' && filterCmd.filters?.length) {
        return {
            action: 'filter_rows',
            mode: filterCmd.mode,
            filters: filterCmd.filters,
            combine: filterCmd.combine || 'and',
            planner: 'regex',
        };
    }

    // «удали колонку Группа» — убрать всю колонку
    const deleteWholeColumn = /(?:удал\S*|убер\S*|remove|delete)\s+(?:колонк[ауи]?\s+|column\s+)/i.test(t);
    if (deleteWholeColumn) {
        const removeColumnMatch = t.match(
            /(?:удал\S*|убер\S*|remove|delete)\s+(?:колонк[ауи]?|column)\s+["«']?([^"»'\n]+)/i
        );
        return {
            action: 'delete_column',
            sourceColumn: resolveColumnHint(String(removeColumnMatch?.[1] || '').trim(), headers),
            rawColumnHint: removeColumnMatch?.[1] || '',
        };
    }

    // «убери из колонки ОС номер и дату» — вычистить текст ячейки, не удалять колонку
    const stripFromSource =
        /(?:убер\S*|удал\S*|очист\S*|вычист\S*)/i.test(t) &&
        /(?:из|в)\s+колонк/i.test(t) &&
        /(?:номер|дат|инвентар|дату)/i.test(t);

    const extractIntent =
        /(вытащи|извлеки|перенес|перенеси|отдельн|отдельную|разбей|раздели|extract)/i.test(t) &&
        /(дат|адрес|инвентар|номер|inventory)/i.test(t);

    const classifyIntent =
        /(проанализ|классиф|подумай|отправь\s+на\s+анализ|аренд|ремонт|движим|недвижим|имуществ)/i.test(t) &&
        !extractIntent &&
        !stripFromSource &&
        (!/определи/i.test(t) || /(аренд|ремонт|движим|недвижим|тип\s+актив|класс)/i.test(t));

    if (classifyIntent) {
        const sourceColumn = extractColumnFromMessage(t, headers);
        return {
            action: 'classify',
            sourceColumn,
            auditorRule: extractAuditorRule(t, 'classify'),
            threshold: 0.7,
        };
    }

    if (extractIntent || stripFromSource) {
        const sourceColumn = extractColumnFromMessage(t, headers);
        const cleanOnly = stripFromSource && !extractIntent;
        return {
            action: cleanOnly ? 'clean_source' : 'extract',
            sourceColumn,
            auditorRule: '',
            stripFromSource: Boolean(stripFromSource),
            threshold: 0.7,
        };
    }

    return { action: null };
}

module.exports = {
    normalizeText,
    resolveColumnHint,
    parseResultTableCommand,
    parseReplaceIntent,
    extractColumnFromMessage,
    extractAuditorRule,
};
