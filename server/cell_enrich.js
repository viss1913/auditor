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
    const m = t.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
    if (!m) return null;
    return m[0];
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

/** Убрать из исходной ячейки инв. номер и дату (детерминированно, без опоры на кривой LLM-regex) */
function stripExtractedFromText(text) {
    let t = String(text || '').replace(/\r\n/g, '\n');

    const inv = extractInventoryNumber(t);
    const date = extractDate(t);

    if (inv) {
        t = t.replace(new RegExp(escapeRegex(inv), 'gi'), '');
    }
    if (date) {
        t = t.replace(new RegExp(escapeRegex(date), 'gi'), '');
    }

    t = t.replace(/80-\d+/gi, '');
    t = t.replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, '');

    const withoutDate = t.replace(/\b\d{2}\.\d{2}\.\d{4}\b/g, ' ');
    const nums = [...withoutDate.matchAll(/\b\d{6,}\b/g)];
    if (nums.length) {
        const last = nums[nums.length - 1][0];
        if (!inv || last !== inv.replace(/^80-/, '')) {
            t = t.replace(new RegExp(`\\b${escapeRegex(last)}\\b`), '');
        }
    }

    return normalizeCellText(t);
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
        } else {
            v = extractWithPattern(text, f.pattern);
        }
        values[col] = v;
    }
    return values;
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
    extractAddress,
    extractInventoryNumber,
    extractWithPattern,
    applyExtractFields,
    stripExtractedFromText,
    defaultExtractFields,
    sanitizeClassification,
    classifyAssetCell,
    classifyBatchUnique,
};

