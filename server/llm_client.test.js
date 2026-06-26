const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const origFetch = global.fetch;
const origEnv = { ...process.env };

describe('llm_client provider switch', () => {
    beforeEach(() => {
        process.env = { ...origEnv };
        delete process.env.LLM_PROVIDER;
        delete process.env.GEMINI_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
        delete process.env.LLM_API_KEY;
    });

    afterEach(() => {
        process.env = origEnv;
        global.fetch = origFetch;
    });

    it('resolveProvider: gemini when GEMINI_API_KEY set', () => {
        process.env.GEMINI_API_KEY = 'test-key';
        const { resolveProvider } = require('./llm_client');
        assert.equal(resolveProvider(), 'gemini');
    });

    it('resolveProvider: explicit openai wins', () => {
        process.env.GEMINI_API_KEY = 'test-key';
        process.env.LLM_PROVIDER = 'openai';
        process.env.OPENROUTER_API_KEY = 'or-key';
        const { resolveProvider } = require('./llm_client');
        assert.equal(resolveProvider(), 'openai');
    });

    it('chatCompletion routes to Gemini API', async () => {
        process.env.LLM_PROVIDER = 'gemini';
        process.env.GEMINI_API_KEY = 'gk';
        process.env.GEMINI_MODEL = 'gemini-2.0-flash';

        let calledUrl = '';
        global.fetch = async (url, opts) => {
            calledUrl = String(url);
            return {
                ok: true,
                json: async () => ({
                    candidates: [
                        {
                            content: {
                                parts: [{ text: 'Привет от Gemini' }],
                            },
                        },
                    ],
                }),
            };
        };

        delete require.cache[require.resolve('./llm_client')];
        const { chatCompletion } = require('./llm_client');
        const out = await chatCompletion({
            messages: [{ role: 'user', content: 'тест' }],
        });
        assert.match(calledUrl, /generativelanguage\.googleapis\.com/);
        assert.equal(out.content, 'Привет от Gemini');
    });

    it('chatCompletion falls back to openai on Gemini timeout', async () => {
        process.env.LLM_PROVIDER = 'gemini';
        process.env.GEMINI_API_KEY = 'gk';
        process.env.LLM_FALLBACK_PROVIDER = 'openai';
        process.env.OPENROUTER_API_KEY = 'or-key';
        process.env.LLM_BASE_URL = 'https://openrouter.ai/api/v1';

        let callCount = 0;
        global.fetch = async (url) => {
            callCount += 1;
            if (String(url).includes('googleapis')) {
                throw new Error('LLM timeout 20000ms');
            }
            return {
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: 'fallback ok' } }],
                }),
            };
        };

        delete require.cache[require.resolve('./llm_client')];
        const { chatCompletion } = require('./llm_client');
        const out = await chatCompletion({
            messages: [{ role: 'user', content: 'тест' }],
        });
        assert.equal(callCount, 2);
        assert.equal(out.content, 'fallback ok');
    });
});
