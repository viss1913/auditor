const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');

function formatRowsSample(data, maxRows = 35) {
    return (data || [])
        .slice(0, maxRows)
        .map((row, i) => {
            const cells = (Array.isArray(row) ? row : [])
                .slice(0, 10)
                .map((v) => String(v ?? '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .join(' | ');
            return `${i}: ${cells || '(пусто)'}`;
        })
        .join('\n');
}

/**
 * LLM: найти строку начала таблицы сделок брокера (раздел 1.2).
 * @returns {Promise<{ startRow: number|null, reason?: string }>}
 */
async function probeBrokerSectionStart(data) {
    const sample = formatRowsSample(data);
    const { content } = await chatCompletion({
        messages: [
            {
                role: 'system',
                content:
                    'Ты анализируешь отчёт брокера. Ищешь начало раздела 1.2 со сделками (не исполнены / ожидают исполнения). Верни JSON: {"startRow": число или null, "reason": "кратко"}',
            },
            {
                role: 'user',
                content: `Первые строки файла:\n${sample}\n\nНа какой строке (0-based index) начинается таблица сделок раздела 1.2?`,
            },
        ],
        temperature: 0.1,
        responseFormat: { type: 'json_object' },
    });

    const parsed = extractJsonFromLlmContent(content);
    const startRow = Number(parsed.startRow);
    if (!Number.isFinite(startRow) || startRow < 0) {
        return { startRow: null, reason: parsed.reason || 'not found' };
    }
    return { startRow, reason: parsed.reason || '' };
}

module.exports = {
    probeBrokerSectionStart,
    formatRowsSample,
};
