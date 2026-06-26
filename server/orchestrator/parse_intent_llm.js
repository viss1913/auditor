const { chatCompletion, extractJsonFromLlmContent } = require('../llm_client');
const { extractFilePrefixFromText } = require('./structure_resolve');

const ALLOWED_SCENARIOS = new Set(['opif_broker', 'opif_depo', null]);
const ALLOWED_SECTIONS = new Set(['1.1', '1.2', null]);

function buildParseIntentPrompt(userMessage, probe = null) {
    const probeLine = probe
        ? `Файлы в папке: ${probe.fileCount || 0}, suggested=${probe.suggestedScenario || '?'}, prefix=${probe.prefix || '?'}`
        : '';
    return `Ты — Martin, помощник аудитора BankFuture. Разбери команду аудитора про ПАРС файлов.

Сценарии:
- opif_broker — Excel-отчёты брокера OPIF (имена 1F018_*, 1F008_* и т.п.), таблицы сделок
- opif_depo — PDF выписки депозитария (зачисление/списание ЦБ)

Брокерский Excel — две секции (разные таблицы внутри файла):
- 1.1 — «Сделки, обязательства из которых ПРЕКРАЩЕНЫ» (синонимы: прекращены, закрыты, исполнены/терминированы на дату, раздел 1.1)
- 1.2 — «Сделки, обязательства из которых НЕ ИСПОЛНЕНЫ» (синонимы: не исполнены, открытые обязательства, ожидают исполнения, раздел 1.2)

Если аудитор не уточнил секцию — brokerSection: null (система возьмёт 1.2 по умолчанию).
Префикс файлов: обычно 1F018_ (из «1F018», «файлы 1F018»).

${probeLine}

Команда аудитора:
«${String(userMessage || '').slice(0, 1200)}»

Верни строго JSON без markdown:
{
  "scenarioId": "opif_broker" | "opif_depo" | null,
  "filePrefix": "1F018_" | null,
  "brokerSection": "1.1" | "1.2" | null,
  "mergeOneTable": true | false | null,
  "confidence": 0.0-1.0,
  "reason": "кратко по-русски"
}`;
}

function normalizePrefix(prefix) {
    const p = String(prefix || '').trim();
    if (!p) return null;
    return p.endsWith('_') ? p : `${p}_`;
}

function sanitizeLlmParseIntent(raw, userMessage) {
    if (!raw || typeof raw !== 'object') return null;
    const scenarioId = ALLOWED_SCENARIOS.has(raw.scenarioId) ? raw.scenarioId : null;
    let filePrefix = normalizePrefix(raw.filePrefix) || extractFilePrefixFromText(userMessage);
    const brokerSection = ALLOWED_SECTIONS.has(raw.brokerSection) ? raw.brokerSection : null;
    const confidence = Math.min(1, Math.max(0, Number(raw.confidence) || 0));
    return {
        scenarioId,
        filePrefix,
        brokerSection,
        mergeOneTable: raw.mergeOneTable === true ? true : raw.mergeOneTable === false ? false : null,
        confidence,
        reason: String(raw.reason || '').trim(),
        source: 'llm',
    };
}

/**
 * LLM-разбор человеческой команды на парс (брокер OPIF / ДЕПО).
 * @returns {Promise<object|null>}
 */
async function resolveParseIntentWithLlm(userMessage, probe = null) {
    const msg = String(userMessage || '').trim();
    if (!msg) return null;

    const { content } = await chatCompletion({
        messages: [
            { role: 'system', content: 'Ты разбираешь команды аудитора. Только JSON.' },
            { role: 'user', content: buildParseIntentPrompt(msg, probe) },
        ],
        temperature: 0.05,
        responseFormat: { type: 'json_object' },
    });

    return sanitizeLlmParseIntent(extractJsonFromLlmContent(content), msg);
}

module.exports = {
    buildParseIntentPrompt,
    resolveParseIntentWithLlm,
    sanitizeLlmParseIntent,
};
