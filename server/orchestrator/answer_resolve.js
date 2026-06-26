const { chatCompletion, extractJsonFromLlmContent } = require('../llm_client');
const { extractFilePrefixFromText } = require('./structure_resolve');

function normalizeText(text) {
    return String(text || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function resolveAnswerRegex(text, question) {
    if (!question) return null;
    const t = normalizeText(text);
    if (!t) return null;

    for (const opt of question.options || []) {
        const label = normalizeText(opt.label);
        const value = normalizeText(opt.value);
        if (t === label || t === value) return opt.value;
        if (label && (label.includes(t) || t.includes(label))) return opt.value;
    }

    if (question.id === 'pick_tree_flatten') {
        if (/^(да|yes|разверн|плоск|подтверд|ок|окей|давай|ага|угу|конечно)/i.test(t)) return 'confirm';
        if (/^(нет|no|осв|08|оборотн|не надо|остав)/i.test(t)) {
            const osv = (question.options || []).find((o) => String(o.value).includes('os_08'));
            return osv?.value || 'scenario:os_08_osv';
        }
    }

    if (question.id === 'pick_scenario') {
        if (/плоск|flat|без дерев/i.test(t)) return 'os_01_flat';
        if (/дерев|иерарх|hierarch|с групп/i.test(t)) return 'os_01_hierarchy';
    }

    const colLetterMap = { ай: 'I', аш: 'H', а: 'A', б: 'B', с: 'C', ц: 'C', д: 'D', е: 'E' };
    const colWord = t.match(/колонк[аеу]?\s*([a-zа-я]{1,3})/i);
    if (colWord && question.id?.includes('column')) {
        const raw = colWord[1].toLowerCase();
        const letter = (colLetterMap[raw] || raw).toUpperCase();
        const hit = (question.options || []).find((o) =>
            String(o.label || '').toUpperCase().includes(`КОЛОНКА ${letter}`)
        );
        if (hit) return hit.value;
    }

    const numMatch = t.match(/\b(\d+)\b/);
    if (numMatch && question.id?.includes('column')) {
        const hit = (question.options || []).find((o) => String(o.value) === numMatch[1]);
        if (hit) return hit.value;
    }

    if (question.id === 'pick_composite_field') {
        if (/инвентар/i.test(t)) return 'inventory_number';
        if (/дата/i.test(t)) return 'date_ddmmyyyy';
    }

    return null;
}

async function resolveAnswerWithLlm(text, question, layoutMeta = null) {
    const options = (question?.options || [])
        .map((o) => `- value: "${o.value}", label: "${o.label}"`)
        .join('\n');

    const prompt = `Ты помогаешь аудитору ответить на вопрос Martin при разборе Excel.

Вопрос (id): ${question?.id || 'unknown'}
Текст вопроса: ${question?.promptTemplate || ''}

Допустимые ответы (value):
${options || '(нет списка — верни null)'}

Ответ пользователя: «${text}»

Верни строго JSON без markdown:
{"value": "<один из value выше или null>", "confidence": 0.0-1.0, "reason": "кратко"}

Если ответ неясный — value: null.`;

    const layoutHint = layoutMeta?.recommended
        ? `\nLayout файла: ${layoutMeta.recommended.layout_type}`
        : '';

    const { content } = await chatCompletion({
        messages: [
            { role: 'system', content: 'Ты разбираешь ответы аудитора. Только JSON.' },
            { role: 'user', content: prompt + layoutHint },
        ],
        temperature: 0.1,
        responseFormat: { type: 'json_object' },
    });

    const parsed = extractJsonFromLlmContent(content);
    if (!parsed?.value || parsed.value === 'null') return null;

    const allowed = new Set((question?.options || []).map((o) => String(o.value)));
    if (allowed.size && !allowed.has(String(parsed.value))) return null;

    return {
        value: String(parsed.value),
        confidence: Number(parsed.confidence) || 0.5,
        reason: parsed.reason || '',
        source: 'llm',
    };
}

/**
 * @param {{ userText: string, question?: object, layoutMeta?: object, useLlm?: boolean }} opts
 * @returns {Promise<{ value: string, source: 'regex'|'llm'|'prefix', confidence?: number, reason?: string } | null>}
 */
async function resolveAnswerFromText({ userText, question, layoutMeta, useLlm = true }) {
    if (!userText) return null;

    const prefix = extractFilePrefixFromText(userText);
    if (prefix && (!question || question.id === 'file_prefix')) {
        return { value: prefix, source: 'prefix', confidence: 0.9 };
    }

    if (!question) return null;

    const regexHit = resolveAnswerRegex(userText, question);
    if (regexHit) {
        return { value: regexHit, source: 'regex', confidence: 0.95 };
    }

    if (!useLlm) return null;

    try {
        const llmHit = await resolveAnswerWithLlm(userText, question, layoutMeta);
        return llmHit;
    } catch {
        return null;
    }
}

module.exports = {
    resolveAnswerFromText,
    resolveAnswerRegex,
    resolveAnswerWithLlm,
    normalizeText,
};
