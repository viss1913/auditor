/**
 * Клиент LLM: Google Gemini (основной) или OpenAI-совместимый API (OpenRouter/Ollama).
 */

function resolveProvider() {
    const explicit = String(process.env.LLM_PROVIDER || '').trim().toLowerCase();
    if (explicit === 'gemini' || explicit === 'openai') return explicit;
    if (process.env.GEMINI_API_KEY) return 'gemini';
    return 'openai';
}

function resolveFallbackProvider() {
    const fb = String(process.env.LLM_FALLBACK_PROVIDER || 'openai').trim().toLowerCase();
    return fb === 'gemini' ? 'gemini' : 'openai';
}

function shouldFallback(err) {
    const msg = String(err?.message || err || '');
    return (
        /timeout/i.test(msg) ||
        /429/.test(msg) ||
        /503/.test(msg) ||
        /rate limit/i.test(msg) ||
        /overloaded/i.test(msg)
    );
}

function openAiMessagesToGemini(messages) {
    const systemParts = [];
    const contents = [];
    for (const m of messages || []) {
        const text = String(m.content || '');
        if (!text) continue;
        if (m.role === 'system') {
            systemParts.push(text);
            continue;
        }
        const role = m.role === 'assistant' ? 'model' : 'user';
        if (contents.length && contents[contents.length - 1].role === role) {
            contents[contents.length - 1].parts[0].text += `\n\n${text}`;
        } else {
            contents.push({ role, parts: [{ text }] });
        }
    }
    if (contents.length && contents[0].role !== 'user') {
        contents.unshift({ role: 'user', parts: [{ text: 'Продолжи диалог.' }] });
    }
    return {
        systemInstruction: systemParts.length
            ? { parts: [{ text: systemParts.join('\n\n') }] }
            : undefined,
        contents,
    };
}

async function chatCompletionGemini({ messages, temperature = 0.1, responseFormat = null, tools = null }) {
    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) throw new Error('GEMINI_API_KEY не задан в .env');

    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const timeoutMs = Number(process.env.LLM_TIMEOUT_MS || 20000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const { systemInstruction, contents } = openAiMessagesToGemini(messages);
    const body = {
        contents,
        generationConfig: {
            temperature,
            ...(responseFormat?.type === 'json_object' ? { responseMimeType: 'application/json' } : {}),
        },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (tools?.length) {
        body.tools = [{ functionDeclarations: tools }];
    }

    let response;
    try {
        response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify(body),
            }
        );
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`LLM timeout ${timeoutMs}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`Gemini API ${response.status}: ${errBody.slice(0, 500)}`);
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const textParts = parts.filter((p) => p.text).map((p) => p.text);
    const content = textParts.join('\n').trim();

    const functionCalls = parts
        .filter((p) => p.functionCall)
        .map((p) => ({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
                name: p.functionCall.name,
                arguments: JSON.stringify(p.functionCall.args || {}),
            },
        }));

    if (!content && !functionCalls.length) {
        throw new Error('Пустой ответ от Gemini');
    }

    return {
        content: content || '',
        tool_calls: functionCalls.length ? functionCalls : undefined,
        raw: data,
    };
}

async function chatCompletionOpenAi({ messages, temperature = 0.1, responseFormat = null, tools = null }) {
    const baseUrl = (process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY || '';
    const model =
        process.env.QWEN_MODEL ||
        process.env.LLM_MODEL ||
        process.env.GEMINI_MODEL ||
        'qwen/qwen-2.5-7b-instruct';

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
                ...(tools?.length
                    ? {
                          tools: tools.map((t) => ({
                              type: 'function',
                              function: {
                                  name: t.name,
                                  description: t.description,
                                  parameters: t.parameters,
                              },
                          })),
                      }
                    : {}),
            }),
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw new Error(`LLM timeout ${timeoutMs}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`LLM API ${response.status}: ${errBody.slice(0, 500)}`);
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;
    const content = message?.content;
    if (!content && !message?.tool_calls?.length) throw new Error('Пустой ответ от LLM');
    return {
        content: (content || '').trim(),
        tool_calls: message?.tool_calls,
        raw: data,
    };
}

async function chatCompletionWithProvider(provider, opts) {
    if (provider === 'gemini') return chatCompletionGemini(opts);
    return chatCompletionOpenAi(opts);
}

/**
 * @param {{ messages: Array, temperature?: number, responseFormat?: object, tools?: Array }} opts
 */
async function chatCompletion(opts) {
    const primary = resolveProvider();
    const fallback = resolveFallbackProvider();

    try {
        return await chatCompletionWithProvider(primary, opts);
    } catch (err) {
        if (fallback !== primary && shouldFallback(err)) {
            return await chatCompletionWithProvider(fallback, opts);
        }
        throw err;
    }
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

function getActiveLlmProvider() {
    return resolveProvider();
}

module.exports = {
    chatCompletion,
    chatCompletionGemini,
    chatCompletionOpenAi,
    extractJsonFromLlmContent,
    getActiveLlmProvider,
    resolveProvider,
};
