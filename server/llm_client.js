/**
 * Клиент LLM (OpenAI-совместимый API): OpenRouter или локальный Ollama.
 */
async function chatCompletion({ messages, temperature = 0.1, responseFormat = null }) {
    const baseUrl = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || '';
    const model = process.env.QWEN_MODEL || process.env.LLM_MODEL || 'qwen/qwen-2.5-7b-instruct';

    if (!apiKey && baseUrl.includes('openrouter')) {
        throw new Error('OPENROUTER_API_KEY не задан в .env');
    }

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 20000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
        response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model,
                messages,
                temperature,
                ...(responseFormat ? { response_format: responseFormat } : {}),
            }),
        });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`LLM timeout ${timeoutMs}ms`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`LLM API ${response.status}: ${errBody.slice(0, 500)}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Пустой ответ от LLM');
    return { content: content.trim() };
}

function extractJsonFromLlmContent(content) {
    let text = content.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        text = text.slice(start, end + 1);
    }
    return JSON.parse(text);
}

module.exports = { chatCompletion, extractJsonFromLlmContent };
