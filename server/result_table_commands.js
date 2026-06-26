const { parseFilterIntent, parseSplitToTableIntent } = require('./table_row_filter');
const { defaultCounterpartyNumberFields, inferExtractFieldsFromMessage, normalizeCellText, escapeRegex } = require('./cell_enrich');
const { resolveContainsRulesForCommand, wantsUkDealTypeColumn } = require('./operation_type_derive');
const { splitCompositeLines, splitKsBlock3 } = require('./ks_sheet_martin');

function addReplaceMapping(mappings, seen, from, to) {
    const f = String(from || '').trim();
    const t = String(to || '').trim();
    if (!f || !t) return;
    const key = `${f}=>${t}`;
    if (seen.has(key)) return;
    seen.add(key);
    mappings.push({ from: f, to: t });
}

function canonicalOperationTypeValue(hint) {
    const n = normalizeText(hint);
    if (!n) return String(hint || '').trim();
    if (/списан/.test(n)) return 'Списание ЦБ';
    if (/зачисл/.test(n)) return 'Зачисление ЦБ';
    if (/покупк/.test(n) && /цб/.test(n)) return 'Покупка ЦБ';
    return String(hint).trim();
}

function isReplaceIntent(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (/замен|подмен|replace/i.test(raw)) return true;
    if (/нов(?:ую|ая)\s+(?:таблиц|вкладк)/i.test(raw)) return false;
    if (!/\s+на\s+/i.test(raw)) return false;
    return /(?:списан|зачисл|покупк|продаж)/i.test(raw);
}

function parseReplaceIntent(text, headers = []) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    if (!isReplaceIntent(raw)) return null;

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

    const casualNa = raw.match(
        /(?:а\s+)?(?:теперь|тепрь)\s+(?:там\s+)?(?:где\s+)?(.+?)\s+на\s+(.+)$/i
    );
    if (casualNa) {
        const from = canonicalOperationTypeValue(casualNa[1]);
        const to = String(casualNa[2] || '').trim();
        if (from && to) addReplaceMapping(mappings, seen, from, to);
    }

    if (/замен|подмен|replace/i.test(raw)) {
        if (/списан/i.test(raw) && /продаж/i.test(raw)) {
            addReplaceMapping(mappings, seen, 'Списание ЦБ', 'продажа');
        }
        if (/покупк|зачисл|попкук/i.test(raw)) {
            addReplaceMapping(mappings, seen, 'Покупка ЦБ', 'покупка');
            addReplaceMapping(mappings, seen, 'Зачисление ЦБ', 'покупка');
        }
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
            объект: 'Объект',
            обьект: 'Объект',
            описание: 'Описание операции',
            'описание операции': 'Описание операции',
            сделка: '№ сделки, дата, время заключения сделки',
            'номер сделки': '№ сделки, дата, время заключения сделки',
            сумма: 'Сумма, руб.',
            портфель: 'Портфель',
            счет: 'Номер брокерского счета клиента',
            договор: 'Договор о брокерском обслуживании',
        };
        const alias = aliasMap[requestedNorm];
        if (alias) hit = headerNorms.find((x) => x.norm === normalizeText(alias))?.header;
    }
    return hit || null;
}

function hintMentionedInText(textNorm, hint) {
    const h = normalizeText(hint);
    if (!h || !textNorm) return false;
    if (textNorm.includes(h)) return true;
    const stemLen = Math.min(5, h.length);
    const stem = h.slice(0, stemLen);
    return textNorm.split(/\s+/).some((w) => w.length >= stemLen && w.startsWith(stem));
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

    const brokerHints = [
        'описание',
        'описание операции',
        'сделка',
        'номер сделки',
        'сумма',
        'портфель',
        'счет',
        'договор',
    ];
    const textNorm = normalizeText(text);
    for (const hint of brokerHints) {
        if (hintMentionedInText(textNorm, hint)) {
            const col = resolveColumnHint(hint, headers);
            if (col) return col;
        }
    }

    for (const h of headers || []) {
        const hn = normalizeText(h);
        if (hn.length >= 2 && normalizeText(text).includes(hn)) return h;
    }
    return null;
}

function extractFillValueFromTemplate(sourceText, template, targetColumnName) {
    const text = String(sourceText ?? '').trim();
    if (!text) return '';

    const tmpl = normalizeText(template || '');
    const colNorm = normalizeText(targetColumnName || '');

    if (/подраздел/.test(tmpl) || /подраздел/.test(colNorm)) {
        const flat = text.replace(/\r?\n/g, ' ');
        const inline = flat.match(/подразделение\s+\d+/i);
        if (inline) return inline[0].trim();
        const lines = splitCompositeLines(text);
        if (lines.length) {
            const b = splitKsBlock3(lines);
            if (b.subdivision_kt) return b.subdivision_kt;
        }
        const m = flat.match(/подразделение\s+(\d+)/i);
        if (m) return `Подразделение ${m[1]}`;
        return '';
    }

    const labelMatch = String(template || '').match(/^(.+?)\s*\[номер\]/i);
    if (labelMatch) {
        const label = labelMatch[1].trim();
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`${escaped}\\s+(\\d+)`, 'i');
        const m = text.replace(/\r?\n/g, ' ').match(re);
        if (m) return `${label} ${m[1]}`;
    }

    return '';
}

function removeTransferredFromSource(sourceText, extractedValue, template, targetColumnName) {
    const text = String(sourceText ?? '');
    if (!text.trim()) return text;

    const extracted = String(extractedValue ?? '').trim();
    const tmpl = normalizeText(template || '');
    const colNorm = normalizeText(targetColumnName || '');

    if (/подраздел/.test(tmpl) || /подраздел/.test(colNorm) || /подразделение\s+\d+/i.test(extracted)) {
        const lines = splitCompositeLines(text);
        if (lines.length > 1) {
            const filtered = lines.filter((l) => !/подраздел/i.test(l));
            if (filtered.length < lines.length) {
                return filtered.join('\n').trim();
            }
        }
        let t = text.replace(/\r?\n/g, ' ');
        if (extracted) {
            t = t.replace(new RegExp(escapeRegex(extracted), 'gi'), '');
        }
        t = t.replace(/подразделение\s+\d+/gi, '');
        return normalizeCellText(t.replace(/\s{2,}/g, ' ').trim());
    }

    if (extracted) {
        let t = text.replace(new RegExp(escapeRegex(extracted), 'gi'), '');
        return normalizeCellText(t.replace(/\s{2,}/g, ' ').trim());
    }

    const labelMatch = String(template || '').match(/^(.+?)\s*\[номер\]/i);
    if (labelMatch) {
        const label = labelMatch[1].trim();
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let t = text.replace(/\r?\n/g, ' ');
        t = t.replace(new RegExp(`${escaped}\\s+\\d+`, 'gi'), '');
        return normalizeCellText(t.replace(/\s{2,}/g, ' ').trim());
    }

    return text;
}

function wantsStripFillFromSource(message) {
    const t = String(message || '');
    return (
        /из\s+ячеек?\s+убер/i.test(t) ||
        /убер\w*\s+.*(?:из\s+)?ячеек/i.test(t) ||
        /убер\w*\s+(?:значен|то\s+что\s+перенес)/i.test(t) ||
        /убер\w*.*(?:перенес|заполн)/i.test(t) ||
        (/убер\w*/i.test(t) && /(?:из|в)\s+колонк/i.test(t) && /(?:подраздел|аналитик|значен|перенес)/i.test(t))
    );
}

function isDeriveColumnIntent(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    const n = normalizeText(t);
    if (/тип/.test(n) && /делк/.test(n) && (/operation_type|операц/i.test(t) || /поступлен|списан|переоценк|если|помест/i.test(t))) {
        return true;
    }
    if (/тип\s+сделк/.test(n) && (/если\s+есть|поступлен|списан|переоценк|→|->/i.test(t))) return true;
    if (
        /operation_type/i.test(t) &&
        (/если\s+(?:там\s+)?есть|поступлен|списан/i.test(t) || /помест/i.test(t)) &&
        (/покупк|продаж|переоценк/i.test(t) || /operation_type_classified/i.test(t))
    ) {
        return true;
    }
    if (/если\s+есть/.test(n) && /(?:то|—|–|-|:|→|->)/.test(t) && /убер|удал/i.test(t) && !COLUMN_WORD_RE.test(t)) {
        return true;
    }
    return false;
}

function inferOperationTypeColumn(headers) {
    return (
        resolveColumnHint('operation_type', headers) ||
        ((headers || []).includes('operation_type') ? 'operation_type' : null) ||
        (headers || []).find((h) => /operationtype/i.test(String(h).replace(/_/g, ''))) ||
        null
    );
}

function normalizeTradeTypeColumnName(name) {
    const n = normalizeText(name);
    if (/тип/.test(n) && /делк/.test(n)) return 'Тип сделки';
    return String(name || '').trim();
}

function canonicalTradeTypeColumnName(text) {
    if (/тип/.test(normalizeText(text)) && /делк/.test(normalizeText(text))) return 'Тип сделки';
    const m = String(text || '').match(/тип\s+сделк[а-яё]*/i);
    if (m) {
        const raw = m[0].trim();
        return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    }
    return null;
}

function parseDeriveTargetColumnName(text, headers) {
    const t = String(text || '');
    const tradeType = canonicalTradeTypeColumnName(t);
    if (tradeType) return tradeType;

    const placed = t.match(
        /(?:в\s+)?(?:новую\s+)?колонк[ау]\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+помест/i
    );
    if (placed?.[1] && !/^operation_type$/i.test(placed[1])) {
        const name = placed[1].trim();
        return findHeaderByNorm(headers, name) || name;
    }

    const named = t.match(/колонк[ау]\s+([a-zA-Z_][a-zA-Z0-9_]*)(?:\s+помест|\s+и\s+|\s*$)/i);
    if (named?.[1] && !/^operation_type$/i.test(named[1])) {
        const name = named[1].trim();
        if (/classified|тип|сделк/i.test(name) || headers.includes(name)) {
            return findHeaderByNorm(headers, name) || name;
        }
    }

    if (/operation_type_classified/i.test(t)) {
        return findHeaderByNorm(headers, 'operation_type_classified') || 'operation_type_classified';
    }

    if (wantsUkDealTypeColumn('', t)) return 'Тип сделки';
    return null;
}

function resolveDeriveSourceColumn(headers, targetColumnName, hintedColumn) {
    const targetNorm = normalizeText(targetColumnName);
    const opCol = inferOperationTypeColumn(headers);
    const hint = hintedColumn && headers.includes(hintedColumn) ? hintedColumn : null;
    if (hint && normalizeText(hint) !== targetNorm) return hint;
    return opCol;
}

function findHeaderByNorm(headers, name) {
    const n = normalizeText(name);
    return (headers || []).find((h) => normalizeText(h) === n) || null;
}

function parseDeriveColumnIntent(text, headers) {
    const t = String(text || '').trim();
    if (!isDeriveColumnIntent(t)) return null;

    const newColumnName =
        parseDeriveTargetColumnName(t, headers) ||
        (/тип/.test(normalizeText(t)) && /делк/.test(normalizeText(t)) ? 'Тип сделки' : null);
    if (!newColumnName) return null;
    const existingColumn = findHeaderByNorm(headers, newColumnName);
    const fillFromColumn = resolveDeriveSourceColumn(headers, newColumnName, null);

    let containsRules = resolveContainsRulesForCommand({
        message: t,
        newColumnName,
        fillFromColumn,
    });
    if (!containsRules.length && fillFromColumn && wantsUkDealTypeColumn(newColumnName, t)) {
        containsRules = resolveContainsRulesForCommand({
            message: `${t} operation_type`,
            newColumnName,
            fillFromColumn,
        });
    }
    if (!containsRules.length && !fillFromColumn) return null;

    const anchor =
        parseColumnAnchorFromMessage(t, headers) ||
        (headers.includes('document')
            ? { afterColumn: 'document', position: 'after', rawAfterHint: 'document' }
            : null);

    const base = {
        newColumnName: existingColumn || newColumnName,
        targetColumn: existingColumn || newColumnName,
        fillFromColumn,
        rawFillColumnHint: fillFromColumn || 'operation_type',
        containsRules,
        stripFillFromSource:
            wantsStripFillFromSource(t) ||
            (containsRules.some((r) => r.strip) && /убер|удал/i.test(t)),
        planner: 'regex',
        fillTemplate: '',
    };

    if (anchor?.afterColumn) {
        base.afterColumn = anchor.afterColumn;
        base.position = anchor.position || 'after';
        base.rawAfterHint = anchor.rawAfterHint;
    }

    if (existingColumn) {
        return { action: 'fill_column', ...base };
    }
    return { action: 'add_column', ...base };
}

function inferFillTemplate(targetColumn) {
    if (/подраздел/i.test(String(targetColumn || ''))) {
        return 'Подразделение [номер]';
    }
    return '';
}

function parseCreatedColumnFromMessage(content) {
    const base = String(content || '').match(/(?:создай|добавь|сделай)\s+колонк[ауи]?\s+/i);
    if (!base) return null;
    const after = String(content).slice(base.index + base[0].length);
    const name = extractQuotedOrWords(after);
    return name || null;
}

function inferTargetColumnFromHistory(message, headers, chatHistory = []) {
    if (/туда/i.test(message)) {
        for (const msg of [...chatHistory].reverse()) {
            const created = parseCreatedColumnFromMessage(msg?.content);
            if (created) return created;
        }
        const hit = (headers || []).find((h) => /подраздел/i.test(h));
        if (hit) return hit;
        return null;
    }

    const explicit = extractColumnFromMessage(message, headers);
    if (explicit) return explicit;

    for (const msg of [...chatHistory].reverse()) {
        const created = parseCreatedColumnFromMessage(msg?.content);
        if (created) return created;
    }

    return (headers || []).find((h) => /подраздел/i.test(h)) || null;
}

function inferSourceColumnFromHistory(chatHistory = [], headers = []) {
    for (const msg of [...chatHistory].reverse()) {
        const content = String(msg?.content || '');
        const m = content.match(
            /(?:заполни|перенес\w*)\s+(?:туда\s+)?(?:из\s+)?(?:колонк[ауи]?\s+)?["«']?([^"»'\n]+?)["»']?/i
        );
        if (m?.[1]) {
            const col = resolveColumnHint(m[1].trim(), headers);
            if (col) return col;
        }
        const m2 = content.match(/(?:из|от)\s+(?:колонк[ауи]?\s+)?["«']?([^"»'\n]+?)["»']?/i);
        if (m2?.[1] && /аналитик/i.test(m2[1])) {
            const col = resolveColumnHint(m2[1].trim(), headers);
            if (col) return col;
        }
    }
    return (
        (headers || []).find((h) => /аналитик.*кт/i.test(normalizeText(h))) ||
        (headers || []).find((h) => /аналитик/i.test(normalizeText(h))) ||
        null
    );
}

function parseFillTransferIntent(text, headers, chatHistory = []) {
    const t = String(text || '').trim();
    if (!/(?:перенес|перенси|заполни|вынеси|вытащи)/i.test(t)) return null;
    if (!/(?:туда|заполни\s+колонк|в\s+колонк)/i.test(t) && !/(?:из|от)\s+колонк/i.test(t)) return null;
    if (/(?:добавь|создай|сделай)\s+колонк/i.test(t)) return null;
    if (/(?:дат|адрес|инвентар)/i.test(t) && /(?:вытащи|извлек|отдельн)/i.test(t)) return null;
    if (!/(?:туда|заполни\s+колонк)/i.test(t)) return null;

    const fillMatch = t.match(
        /(?:из|от)\s+(?:колонк[ауи]?\s+)?(?:["«']([^"»']+)["»']|(.+?))(?=\s+соответств|\s+по\s+шаблону|\s+из\s+ячеек|[,.]|$)/i
    );
    if (!fillMatch) return null;

    const hint = String(fillMatch[1] || fillMatch[2] || '').trim();
    const fillFromColumn = resolveColumnHint(hint, headers);
    const targetColumn = inferTargetColumnFromHistory(t, headers, chatHistory);
    const templateMatch = t.match(/по\s+шаблону\s*:\s*(.+)$/i);
    const fillTemplate = templateMatch ? String(templateMatch[1] || '').trim() : inferFillTemplate(targetColumn);

    return {
        action: 'fill_column',
        targetColumn,
        newColumnName: targetColumn,
        fillFromColumn,
        fillTemplate,
        stripFillFromSource: wantsStripFillFromSource(t),
        rawFillColumnHint: hint,
        rawTargetHint: targetColumn ? '' : 'туда',
        planner: 'regex',
    };
}

function parseStripFillFromSourceIntent(text, headers, chatHistory = []) {
    const t = String(text || '').trim();
    if (isDeriveColumnIntent(t)) return null;
    if (/(?:добавь|создай|сделай)\s+.*колонк/i.test(t)) return null;
    if (!wantsStripFillFromSource(t)) return null;
    if (/(?:перенес|перенси|заполни)\w*/i.test(t) && /(?:из|от)\s+колонк/i.test(t)) return null;

    let fillFromColumn = extractColumnFromMessage(t, headers);
    if (!fillFromColumn) {
        fillFromColumn = inferSourceColumnFromHistory(chatHistory, headers);
    }
    if (!fillFromColumn) return null;

    const targetColumn = inferTargetColumnFromHistory(t, headers, chatHistory);
    return {
        action: 'strip_fill_source',
        fillFromColumn,
        targetColumn,
        fillTemplate: inferFillTemplate(targetColumn),
        stripFillFromSource: true,
        planner: 'regex',
    };
}

function extractQuotedOrWords(fragment) {
    const t = String(fragment || '').trim();
    const quoted = t.match(/^["«']([^"»']+)["»']/);
    if (quoted) return quoted[1].trim();
    const rest = t.match(/^(.+?)(?:\s+и\s+заполни|\s+по\s+шаблону|$)/i);
    let name = (rest ? rest[1] : t).trim();
    const tail = name.match(/^(.+?)(?:\.\s*(?:проанализ|заполни|если)|,\s*(?:проанализ|заполни|если))/i);
    if (tail) name = tail[1].trim();
    const fromCol = name.match(/^(.+?)\s+из\s+(?:колонк[ауи]\s+)?(operation_type|operationtype)\s*$/i);
    if (fromCol) name = fromCol[1].trim();
    return name.replace(/[.,]\s*$/, '').trim();
}

const COLUMN_WORD_RE = '(?:колонк[а-яёю]*|столб[а-яёю]*|column)';
const ADD_VERB_RE =
    '(?:добавь|создай|сделай|можешь\\s+сделать|можно\\s+(?:добавить|сделать|создать)|надо\\s+созда(?:ть|й)|нужно\\s+созда(?:ть|й)|надо\\s+сделать|нужно\\s+сделать)';

function parseColumnAnchorFromMessage(text, headers) {
    const t = String(text || '');
    const afterMatch = t.match(
        /(?:после|after)\s+(?:колонк[ауи]\s+)?["«']?([^"»'\n,.]+?)["»']?(?=\s*,|\s+назов|\s+и\s+|\s*$)/i
    );
    const beforeMatch = t.match(
        /(?:перед|before)\s+(?:колонк[ауи]\s+)?["«']?([^"»'\n,.]+?)["»']?(?=\s*,|\s+назов|\s+и\s+|\s*$)/i
    );
    if (afterMatch?.[1]) {
        const hint = afterMatch[1].trim();
        return {
            afterColumn: resolveColumnHint(hint, headers),
            position: 'after',
            rawAfterHint: hint,
        };
    }
    if (beforeMatch?.[1]) {
        const hint = beforeMatch[1].trim();
        return {
            afterColumn: resolveColumnHint(hint, headers),
            position: 'before',
            rawAfterHint: hint,
        };
    }
    return null;
}

function parseNamedColumnFromMessage(text) {
    const t = String(text || '');
    const named = t.match(/назов[а-яё]*\s+(?:новую\s+)?(?:колонк[ауи]\s+)?(.+?)(?:\s*$|[,.])/i);
    if (named?.[1]) return extractQuotedOrWords(named[1].trim());
    return null;
}

function wantsOperationTypeFill(message, newColumnName) {
    const t = String(message || '');
    if (/operation_type|операц|каждой\s+ячейк/i.test(t)) return true;
    if (/заполни|перенес\w*\s+из/i.test(t)) return true;
    if (isDeriveColumnIntent(t)) return true;
    if (
        wantsUkDealTypeColumn(newColumnName, t) &&
        /если\s+есть|поступлен|списан|переоценк|проанализ|проанал|помест/i.test(t)
    ) {
        return true;
    }
    return false;
}

function parseDeleteColumnIntent(text, headers = []) {
    const t = String(text || '').trim();
    if (!t) return null;
    if (isDeriveColumnIntent(t)) return null;
    if (/(?:из|в)\s+(?:колонк|столбц)/i.test(t)) return null;
    if (/(?:все\s+)?(?:строч\w*|строк\w*)\s+где/i.test(t)) return null;

    const removeShort = t.match(/^remove\s+(.+)$/i);
    if (removeShort) {
        const hint = extractQuotedOrWords(removeShort[1]);
        return {
            action: 'delete_column',
            sourceColumn: resolveColumnHint(hint, headers),
            rawColumnHint: hint,
            planner: 'regex',
        };
    }

    const removeMatch = t.match(
        new RegExp(
            `(?:удали|удал|убери|убер|remove|delete)\\s+(?:(?:плиз\\s+|please\\s+)?${COLUMN_WORD_RE}\\s+)?["«']?([^"»'\\n]+)`,
            'i'
        )
    );
    if (removeMatch?.[1]) {
        const hint = String(removeMatch[1]).trim();
        if (hint && !/^(все|строк|row)/i.test(hint)) {
            return {
                action: 'delete_column',
                sourceColumn: resolveColumnHint(hint, headers),
                rawColumnHint: hint,
                planner: 'regex',
            };
        }
    }
    return null;
}

function parseAddColumnIntent(text, headers) {
    const t = String(text || '').trim();

    if (
        /(?:вытащи|извлеки|вынеси)/i.test(t) &&
        /назов[а-яё]*\s+(?:колонк|столбц)/i.test(t) &&
        !/(?:добавь|создай|сделай|надо\s+созда|нужно\s+созда)/i.test(t)
    ) {
        return null;
    }

    const addShort = t.match(/^add\s+(.+)$/i);
    if (addShort) {
        return {
            action: 'add_column',
            newColumnName: extractQuotedOrWords(addShort[1]),
            planner: 'regex',
        };
    }

    const addBase =
        t.match(
            new RegExp(
                `${ADD_VERB_RE}.{0,48}?(?:нов(?:ую|ый|ое)?\\s+)?${COLUMN_WORD_RE}\\s+`,
                'i'
            )
        ) ||
        t.match(/(?:add|create)\s+(?:a\s+)?(?:new\s+)?column\s+/i) ||
        t.match(/(?:надо|нужно)\s+созда(?:ть|й)\s+(?:новую\s+)?(?:колонк|столбц)[а-яё]*/i) ||
        t.match(/(?:надо|нужно)\s+сделать\s+(?:новую\s+)?(?:колонк|столбц)[а-яё]*/i) ||
        t.match(/нов(?:ую|ый|ое)\s+(?:колонк|столбц)[а-яё]*\s+(?:после|перед|after|before)/i) ||
        t.match(/назов[а-яё]*\s+(?:новую\s+)?(?:колонк|столбц)[а-яё]*/i);
    if (!addBase) return null;

    const namedColumn = parseNamedColumnFromMessage(t);
    const newColFromPhrase = t.match(
        new RegExp(
            `нов(?:ую|ый|ое)\\s+(?:${COLUMN_WORD_RE}\\s+)?(.+?)(?:\\.\\s*(?:проанал|и\\s+если|если)|,\\s*(?:проанал|если)|$)`,
            'i'
        )
    );
    const afterName = t.slice(addBase.index + addBase[0].length);
    let newColumnName = normalizeTradeTypeColumnName(
        namedColumn ||
            (newColFromPhrase?.[1] ? extractQuotedOrWords(newColFromPhrase[1].trim()) : null) ||
            extractQuotedOrWords(afterName)
    );
    const anchor =
        parseColumnAnchorFromMessage(t, headers) ||
        (wantsUkDealTypeColumn(newColumnName, t) && headers.includes('document')
            ? { afterColumn: 'document', position: 'after', rawAfterHint: 'document' }
            : null);
    const fillMatch = text.match(
        /заполни\s+(?:из\s+)?(?:колонк[ауи]?\s+)?(?:["«']([^"»']+)["»']|(.+?))(?:\s+по\s+шаблону|$)/i
    );
    const templateMatch = text.match(/по\s+шаблону\s*:\s*(.+)$/i);

    const cmd = {
        action: 'add_column',
        newColumnName,
        planner: 'regex',
    };

    if (anchor?.afterColumn) {
        cmd.afterColumn = anchor.afterColumn;
        cmd.position = anchor.position || 'after';
        cmd.rawAfterHint = anchor.rawAfterHint;
    } else if (anchor?.rawAfterHint) {
        cmd.rawAfterHint = anchor.rawAfterHint;
    }

    if (fillMatch) {
        const hint = String(fillMatch[1] || fillMatch[2] || '').trim();
        cmd.fillFromColumn = resolveColumnHint(hint, headers);
        cmd.fillTemplate = templateMatch ? String(templateMatch[1] || '').trim() : '';
        cmd.rawFillColumnHint = hint;
    }

    if (!cmd.fillFromColumn) {
        const opCol =
            resolveColumnHint('operation_type', headers) ||
            ((headers || []).includes('operation_type') ? 'operation_type' : null);
        if (opCol && /operation_type|операц|каждой\s+ячейк/i.test(t)) {
            cmd.fillFromColumn = opCol;
            cmd.rawFillColumnHint = opCol;
        }
    }

    const wantsFill = wantsOperationTypeFill(t, cmd.newColumnName);
    if (!cmd.fillFromColumn && wantsFill) {
        const opCol = inferOperationTypeColumn(headers);
        if (opCol) {
            cmd.fillFromColumn = opCol;
            cmd.rawFillColumnHint = opCol;
        }
    }

    const containsRules = resolveContainsRulesForCommand({
        message: t,
        newColumnName: cmd.newColumnName,
        fillFromColumn: wantsFill ? cmd.fillFromColumn : null,
    });
    if (containsRules.length) {
        cmd.containsRules = containsRules;
        if (containsRules.some((r) => r.strip)) {
            cmd.stripFillFromSource = true;
        }
    }

    if (!cmd.fillFromColumn && cmd.containsRules?.length && wantsFill) {
        const opCol = inferOperationTypeColumn(headers);
        if (opCol) {
            cmd.fillFromColumn = opCol;
            cmd.rawFillColumnHint = opCol;
        }
    }

    cmd.stripFillFromSource = cmd.stripFillFromSource || wantsStripFillFromSource(text);
    if (!cmd.fillTemplate && cmd.newColumnName) {
        cmd.fillTemplate = inferFillTemplate(cmd.newColumnName);
    }

    return cmd;
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
function parseResultTableCommand(text, headers = [], chatHistory = []) {
    const t = String(text || '').trim();
    if (!t) return { action: null };

    const replaceCmd = parseReplaceIntent(t, headers);
    if (replaceCmd?.action === 'replace_values' && replaceCmd.mappings?.length) {
        return replaceCmd;
    }

    const splitCmd = parseSplitToTableIntent(t, headers);
    if (splitCmd.action === 'split_to_table') {
        return splitCmd;
    }

    if (/(разбери|раскрой|разверни)\s+аналитик/i.test(t)) {
        return { action: 'expand_ks_analytics', planner: 'regex' };
    }

    if (/отмени\s+последн/i.test(t)) {
        return { action: 'undo_last', planner: 'regex' };
    }

    const moveMatch = t.match(
        /перенес[а-яё]*\s+колонк[ауиеё]?\s+["«']?([^"»'\n]+?)["»']?\s+(после|перед|after|before)\s+["«']?([^"»'\n]+)/i
    );
    if (moveMatch) {
        const sourceColumn = resolveColumnHint(String(moveMatch[1] || '').trim(), headers);
        const afterColumn = resolveColumnHint(String(moveMatch[3] || '').trim(), headers);
        const position = /перед|before/i.test(moveMatch[2]) ? 'before' : 'after';
        return {
            action: 'move_column',
            sourceColumn,
            afterColumn,
            position,
            rawColumnHint: moveMatch[1] || '',
            rawAfterHint: moveMatch[3] || '',
        };
    }

    const renameMatch = t.match(
        /переименуй\s+колонк[ауи]?\s+["«']?([^"»'\n]+?)["»']?\s+в\s+["«']?([^"»'\n]+)/i
    );
    if (renameMatch) {
        return {
            action: 'rename_column',
            sourceColumn: resolveColumnHint(String(renameMatch[1] || '').trim(), headers),
            newColumnName: String(renameMatch[2] || '').trim(),
            rawColumnHint: renameMatch[1] || '',
        };
    }

    const fillTransferCmd = parseFillTransferIntent(t, headers, chatHistory);
    if (fillTransferCmd) {
        return fillTransferCmd;
    }

    const stripFillCmd = parseStripFillFromSourceIntent(t, headers, chatHistory);
    if (stripFillCmd) {
        return stripFillCmd;
    }

    const deriveCmd = parseDeriveColumnIntent(t, headers);
    if (deriveCmd) {
        return deriveCmd;
    }

    const addCmd = parseAddColumnIntent(t, headers);
    if (addCmd) {
        return addCmd;
    }

    const dupMatch = t.match(
        /(?:скопируй|дублируй)\s+колонк[ауи]?\s+["«']?([^"»'\n]+?)["»']?\s+(?:как|в)\s+["«']?([^"»'\n]+)/i
    );
    if (dupMatch) {
        return {
            action: 'duplicate_column',
            sourceColumn: resolveColumnHint(String(dupMatch[1] || '').trim(), headers),
            newColumnName: String(dupMatch[2] || '').trim(),
            rawColumnHint: dupMatch[1] || '',
        };
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

    const deleteCmd = parseDeleteColumnIntent(t, headers);
    if (deleteCmd?.action === 'delete_column') {
        return deleteCmd;
    }

    // «убери из колонки ОС номер и дату» — вычистить текст ячейки, не удалять колонку
    const stripFromSource =
        /(?:убер\S*|удал\S*|очист\S*|вычист\S*)/i.test(t) &&
        /(?:из|в)\s+колонк/i.test(t) &&
        /(?:номер|дат|инвентар|дату|подраздел|аналитик|значен|перенес)/i.test(t);

    const extractIntent =
        /(вытащи|извлеки|перенес|перенеси|отдельн|отдельную|разбей|раздели|вынеси|extract)/i.test(t) &&
        /(дат|адрес|инвентар|номер|inventory|сделк|mcxs)/i.test(t);

    const classifyIntent =
        /(проанализ|классиф|подумай|отправь\s+на\s+анализ|аренд|ремонт|движим|недвижим|имуществ)/i.test(t) &&
        !isDeriveColumnIntent(t) &&
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
        const counterpartyExtract =
            !cleanOnly &&
            sourceColumn &&
            /контрагент/i.test(String(sourceColumn)) &&
            /номер/i.test(t);
        return {
            action: cleanOnly ? 'clean_source' : 'extract',
            sourceColumn,
            auditorRule: '',
            stripFromSource: Boolean(stripFromSource),
            extractFields: counterpartyExtract
                ? defaultCounterpartyNumberFields()
                : inferExtractFieldsFromMessage(t),
            threshold: 0.7,
        };
    }

    return { action: null };
}

function formatColumnNotFoundMessage(headers, hint) {
    const list = (headers || []).slice(0, 8);
    const sample = list.join(', ');
    const suffix = (headers || []).length > 8 ? '…' : '';
    const example = list[0] ? `«колонка ${list[0]}»` : 'точное имя из заголовка таблицы';
    if (hint) {
        return `Не нашла колонку «${hint}». Доступные: ${sample}${suffix}. Напиши: ${example}.`;
    }
    return `Не нашла колонку. Доступные: ${sample}${suffix}. Напиши: ${example}.`;
}

function actionNeedsSourceColumn(action) {
    return action === 'extract' || action === 'clean_source' || action === 'classify';
}

module.exports = {
    normalizeText,
    resolveColumnHint,
    formatColumnNotFoundMessage,
    actionNeedsSourceColumn,
    isReplaceIntent,
    canonicalOperationTypeValue,
    parseReplaceIntent,
    parseResultTableCommand,
    extractColumnFromMessage,
    extractAuditorRule,
    extractFillValueFromTemplate,
    removeTransferredFromSource,
    parseAddColumnIntent,
    parseDeriveColumnIntent,
    isDeriveColumnIntent,
    parseFillTransferIntent,
    parseStripFillFromSourceIntent,
    wantsStripFillFromSource,
};
