const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');
const { buildCellClassificationPrompt, isValidCellClassificationJson } = require('./assist_martin');

const ALLOWED_CLASSES = new Set([
    'movable',
    'real_estate',
    'rent',
    'repair',
    'other',
    'not_sure',
]);

function extractDate(text) {
    const t = String(text || '');
    const full = t.match(/\b(\d{2}\.\d{2}\.\d{4})\b/);
    if (full) return full[1];
    const short = t.match(/\b(\d{2}\.\d{2}\.\d{2})\b/);
    if (short) return short[1];
    return null;
}

function extractDealNumber(text) {
    const m = String(text || '').match(/mcxs\d+/i);
    return m ? m[0] : null;
}

function sanitizeTargetColumnName(name) {
    const raw = String(name || '').trim().replace(/^["«']|["»']$/g, '');
    if (!raw) return '';
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(raw)) return raw.slice(0, 48);
    return raw.replace(/\s+/g, ' ').trim().slice(0, 64);
}

function parseTargetColumnFromMessage(message) {
    const t = String(message || '');
    const patterns = [
        /(?:назови|назвать)\s+колонк[ауиё]?\s+["«']?([^"»'\n,.]+)/i,
        /колонк[ауиё]?\s+(?:назови|назови)\s+["«']?([^"»'\n,.]+)/i,
        /новую\s+колонк[ауиё]?\s+["«']?([^"»'\n,.]+)/i,
        /в\s+колонк[ауиё]?\s+["«']?([^"»'\n,.]+?)["»']?(?:\s*$|[,.])/i,
    ];
    for (const re of patterns) {
        const m = t.match(re);
        if (m?.[1]) {
            const col = sanitizeTargetColumnName(m[1].trim());
            if (col) return col;
        }
    }
    return null;
}

function extractCounterpartyNumber(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const labeled = raw.match(/(?:контрагент|counterparty)\s*(\d+)/i);
    if (labeled?.[1]) return labeled[1];
    const trailing = raw.match(/(\d+)\s*$/);
    return trailing?.[1] || null;
}

function extractInventoryNumber(text) {
    const raw = String(text || '').replace(/\r\n/g, '\n');
    const m80 = raw.match(/80-\d+/i);
    if (m80) return m80[0];

    const withoutDate = raw.replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, ' ');
    const nums = [...withoutDate.matchAll(/\b\d{6,}\b/g)].map((m) => m[0]);
    if (!nums.length) return null;
    const candidate = nums.find((n) => n.length >= 8) || nums[nums.length - 1];
    if (candidate && /80-\d+/i.test(raw)) {
        const full = raw.match(/80-\d+/i);
        if (full) return full[0];
    }
    return candidate;
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeCellText(t) {
    return String(t || '')
        .replace(/,\s*,/g, ',')
        .replace(/,\s*$/g, '')
        .replace(/^\s*,\s*/g, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** Убрать из исходной ячейки инв. номер и/или дату (детерминированно, без LLM-regex) */
function stripExtractedFromText(text, stripTargets = { inventory: true, date: true }) {
    let t = String(text || '').replace(/\r\n/g, '\n');
    const stripInventory = stripTargets?.inventory !== false;
    const stripDate = stripTargets?.date !== false;
    const stripDeal = stripTargets?.deal_number !== false;

    const inv = stripInventory ? extractInventoryNumber(t) : null;
    const date = stripDate ? extractDate(t) : null;
    const deal = stripDeal ? extractDealNumber(t) : null;

    if (inv) {
        t = t.replace(new RegExp(escapeRegex(inv), 'gi'), '');
    }
    if (date) {
        t = t.replace(new RegExp(escapeRegex(date), 'gi'), '');
    }
    if (deal) {
        t = t.replace(new RegExp(escapeRegex(deal), 'gi'), '');
    }

    if (stripInventory) {
        t = t.replace(/80-\d+/gi, '');
        const withoutDate = t.replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, ' ');
        const nums = [...withoutDate.matchAll(/\b\d{6,}\b/g)];
        if (nums.length) {
            const last = nums[nums.length - 1][0];
            if (!inv || last !== inv.replace(/^80-/, '')) {
                t = t.replace(new RegExp(`\\b${escapeRegex(last)}\\b`), '');
            }
        }
    }

    if (stripDate) {
        t = t.replace(/\b\d{2}\.\d{2}\.(?:\d{4}|\d{2})\b/g, '');
    }

    return normalizeCellText(t);
}

function inferStripTargets(message) {
    const t = String(message || '')
        .toLowerCase()
        .replace(/ё/g, 'е');
    const wantsInv =
        /инвентар|inventory/.test(t) ||
        (/номер/.test(t) && !/контрагент|counterparty/.test(t));
    const wantsDate = /дат|date/.test(t);
    if (wantsInv && wantsDate) return { inventory: true, date: true };
    if (wantsInv && !wantsDate) return { inventory: true, date: false };
    if (wantsDate && !wantsInv) return { inventory: false, date: true };
    return { inventory: true, date: true };
}

function inventoryOnlyFields() {
    return [
        {
            target_column: 'inventory_extracted',
            pattern: '(80-\\d+)',
            field: 'inventory',
            description: 'инвентарный номер',
        },
    ];
}

function dateOnlyFields(targetColumn = 'date_extracted') {
    return [
        {
            target_column: targetColumn,
            pattern: '\\b\\d{2}\\.\\d{2}\\.(?:\\d{4}|\\d{2})\\b',
            field: 'date',
            description: 'дата',
        },
    ];
}

function dealNumberFields(targetColumn = 'deal_number') {
    return [
        {
            target_column: targetColumn,
            pattern: '(mcxs\\d+)',
            field: 'deal_number',
            description: 'номер сделки',
        },
    ];
}

function inferExtractFieldsFromMessage(message) {
    const t = String(message || '')
        .toLowerCase()
        .replace(/ё/g, 'е');
    const customName = parseTargetColumnFromMessage(message);
    const wantsDeal = /сделк|mcxs|номер\s+сделки/.test(t);
    const wantsDate = /дат|date/.test(t);
    const wantsInv =
        /инвентар|inventory/.test(t) ||
        (/номер/.test(t) && !wantsDeal && !/контрагент|counterparty/.test(t));
    const wantsAddr = /адрес/.test(t);

    const fields = [];
    if (wantsDeal) {
        fields.push(...dealNumberFields(customName && wantsDeal && !wantsDate ? customName : 'deal_number'));
    }
    if (wantsDate) {
        const dateCol =
            customName && wantsDate && !wantsDeal && !wantsInv
                ? customName
                : customName && wantsDeal
                  ? `${customName}_date`
                  : 'date_extracted';
        fields.push(...dateOnlyFields(dateCol));
    }
    if (wantsInv) fields.push(...inventoryOnlyFields());
    if (wantsAddr) {
        fields.push({
            target_column: customName || 'address_extracted',
            pattern: 'по\\s+адресу[^,]+',
            field: 'address',
            description: 'адрес',
        });
    }

    if (fields.length) return fields;

    const targets = inferStripTargets(message);
    const fallback = [];
    if (targets.inventory) fallback.push(...inventoryOnlyFields());
    if (targets.date) fallback.push(...dateOnlyFields());
    return fallback.length ? fallback : defaultExtractFields();
}

function stripTargetsFromFields(fields = []) {
    return {
        inventory: fields.some((f) => f.field === 'inventory'),
        date: fields.some((f) => f.field === 'date'),
        deal_number: fields.some((f) => f.field === 'deal_number'),
    };
}

function extractWithPattern(text, pattern) {
    if (!pattern) return null;
    try {
        const re = new RegExp(pattern, 'i');
        const m = String(text || '').match(re);
        if (!m) return null;
        return String(m[1] ?? m[0]).trim() || null;
    } catch {
        return null;
    }
}

function applyExtractFields(text, extractFields = []) {
    const values = {};
    for (const f of extractFields) {
        const col = f.target_column;
        if (!col) continue;
        let v = null;
        if (f.field === 'inventory') {
            v = extractInventoryNumber(text);
            if (!v) v = extractWithPattern(text, f.pattern);
            if (v && /80-\d+/i.test(text) && !/^80-/i.test(v)) {
                const full = extractInventoryNumber(text);
                if (full) v = full;
            }
        } else if (f.field === 'date') {
            v = extractDate(text);
            if (!v) v = extractWithPattern(text, f.pattern);
        } else if (f.field === 'address') {
            v = extractAddress(text);
            if (!v) v = extractWithPattern(text, f.pattern);
        } else if (f.field === 'counterparty_number') {
            v = extractCounterpartyNumber(text);
            if (!v) v = extractWithPattern(text, f.pattern);
        } else if (f.field === 'deal_number') {
            v = extractDealNumber(text);
            if (!v) v = extractWithPattern(text, f.pattern);
        } else {
            v = extractWithPattern(text, f.pattern);
        }
        if (v != null && String(v).trim() !== '') {
            values[col] = v;
        }
    }
    return values;
}

function defaultCounterpartyNumberFields(targetColumn = 'contragent_number') {
    return [
        {
            target_column: targetColumn,
            pattern: '(?:контрагент|counterparty)\\s*(\\d+)',
            field: 'counterparty_number',
            description: 'номер контрагента',
        },
    ];
}

function defaultExtractFields() {
    return [
        {
            target_column: 'inventory_extracted',
            pattern: '(80-\\d+)',
            field: 'inventory',
            description: 'инвентарный номер',
        },
        {
            target_column: 'date_extracted',
            pattern: '\\b\\d{2}\\.\\d{2}\\.\\d{4}\\b',
            field: 'date',
            description: 'дата',
        },
    ];
}

function extractAddress(text) {
    const t = String(text || '');
    if (!t.trim()) return null;

    const afterAddress = t.match(/по\s+адресу[:\s]*([^,]+(?:,\s*[^,]+){1,4})/i);
    if (afterAddress?.[1]) {
        return afterAddress[1].trim();
    }

    const cityStreet = t.match(
        /\b(?:г\.?\s*[А-ЯA-Zа-яa-z-]+[^,]*,\s*)?(?:ул\.?|улица|проспект|пр-т|пер\.?|ш\.)[^,]*(?:,\s*\d+[а-яa-zА-ЯA-Z-]*)?/i
    );
    if (cityStreet?.[0]) return cityStreet[0].trim();

    return null;
}

function clamp01(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(1, v));
}

function sanitizeClassification(raw, threshold = 0.7) {
    const cls = String(raw?.class || '').trim().toLowerCase();
    const confidence = clamp01(raw?.confidence);
    const reason = String(raw?.reason || '').trim();

    if (!ALLOWED_CLASSES.has(cls)) {
        return { class: 'not_sure', confidence: 0, reason: reason || 'Некорректный формат класса' };
    }
    if (cls === 'not_sure') return { class: cls, confidence, reason: reason || 'Недостаточно контекста' };
    if (confidence < threshold) {
        return {
            class: 'not_sure',
            confidence,
            reason: reason || `Уверенность ниже порога ${threshold}`,
        };
    }
    return { class: cls, confidence, reason: reason || 'ok' };
}

async function classifyAssetCell(text, options = {}) {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.7;
    const auditorRule = String(options.auditorRule || '').trim();
    const prompt = buildCellClassificationPrompt(text, auditorRule);

    const { content } = await chatCompletion({
        messages: [{ role: 'system', content: 'Отвечай только JSON.' }, { role: 'user', content: prompt }],
        temperature: 0.1,
        responseFormat: { type: 'json_object' },
    });
    const parsed = extractJsonFromLlmContent(content);
    if (!isValidCellClassificationJson(parsed)) {
        return { class: 'not_sure', confidence: 0, reason: 'Невалидный JSON-контракт от модели' };
    }
    return sanitizeClassification(parsed, threshold);
}

async function classifyBatchUnique(values, options = {}) {
    const threshold = Number.isFinite(options.threshold) ? options.threshold : 0.7;
    const auditorRule = String(options.auditorRule || '').trim();
    const maxUnique = Number.isFinite(options.maxUnique) ? options.maxUnique : 80;
    const classifier =
        options.classifier ||
        ((text) => classifyAssetCell(text, { threshold, auditorRule }));

    const uniqueOrdered = [];
    const seen = new Set();
    for (const v of values) {
        const key = String(v || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        uniqueOrdered.push(key);
    }

    const cache = new Map();
    const toClassify = uniqueOrdered.slice(0, maxUnique);
    const concurrency = Number.isFinite(options.concurrency) ? options.concurrency : 4;
    let cursor = 0;
    async function worker() {
        while (cursor < toClassify.length) {
            const i = cursor++;
            const key = toClassify[i];
            try {
                const cls = await classifier(key);
                cache.set(key, sanitizeClassification(cls, threshold));
            } catch (e) {
                cache.set(key, {
                    class: 'not_sure',
                    confidence: 0,
                    reason: `Ошибка классификации: ${e.message}`,
                });
            }
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, toClassify.length || 1) }, () => worker());
    await Promise.all(workers);

    const skipReason = `Пропущено: лимит ${maxUnique} уникальных значений за запрос`;
    const results = [];
    for (const v of values) {
        const key = String(v || '').trim();
        if (!key) {
            results.push({ class: 'not_sure', confidence: 0, reason: 'Пустое значение' });
            continue;
        }
        if (cache.has(key)) {
            results.push(cache.get(key));
            continue;
        }
        results.push({ class: 'not_sure', confidence: 0, reason: skipReason });
    }

    return {
        results,
        uniqueClassified: cache.size,
        truncated: uniqueOrdered.length > maxUnique,
    };
}

module.exports = {
    extractDate,
    extractDealNumber,
    extractAddress,
    extractInventoryNumber,
    extractCounterpartyNumber,
    defaultCounterpartyNumberFields,
    dealNumberFields,
    parseTargetColumnFromMessage,
    sanitizeTargetColumnName,
    extractWithPattern,
    applyExtractFields,
    stripExtractedFromText,
    normalizeCellText,
    escapeRegex,
    defaultExtractFields,
    inventoryOnlyFields,
    dateOnlyFields,
    inferExtractFieldsFromMessage,
    inferStripTargets,
    stripTargetsFromFields,
    sanitizeClassification,
    classifyAssetCell,
    classifyBatchUnique,
};

