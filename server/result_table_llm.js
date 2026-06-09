const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');
const { resolveColumnHint } = require('./result_table_commands');

const { sanitizeFilterPlan } = require('./table_row_filter');

const ALLOWED_ACTIONS = new Set([
    'extract',
    'classify',
    'delete_column',
    'clean_source',
    'filter_rows',
    'none',
]);

function pickColumnSamples(rows, headers, sourceColumn, limit = 6) {
    if (!sourceColumn) return [];
    const out = [];
    for (const row of rows || []) {
        const v = String((row && row[sourceColumn]) ?? '').trim();
        if (!v) continue;
        if (out.includes(v)) continue;
        out.push(v);
        if (out.length >= limit) break;
    }
    return out;
}

function buildSamplesByHeader(rows, headers, limitPerCol = 3) {
    const samples = {};
    for (const h of headers || []) {
        samples[h] = pickColumnSamples(rows, headers, h, limitPerCol);
    }
    return samples;
}

function formatChatHistory(chatHistory, limit = 8) {
    const items = (chatHistory || [])
        .filter((m) => m?.content && (m.role === 'user' || m.role === 'assistant'))
        .slice(-limit);
    if (!items.length) return '(нет)';
    return items.map((m) => `${m.role}: ${String(m.content).slice(0, 400)}`).join('\n');
}

function buildResultTablePlannerPrompt({ message, headers, samplesByHeader, chatHistory, activeFilter }) {
    return `Ты — Martin, помощник аудитора. Пользователь работает с УЖЕ ГОТОВОЙ плоской таблицей (режим результата).

Задача: понять запрос и вернуть ПЛАН действия в JSON (без markdown).

Допустимые action:
- extract — вытащить части текста ячейки в новые колонки (инв. номер, дата, адрес). Если пользователь просит «убрать из колонки» — strip_from_source: true
- clean_source — только очистить текст в source_column (убрать номер/дату из ячейки), без новых колонок
- classify — классифицировать ячейки (аренда/движимое/недвижимое) через auditor_rule
- delete_column — удалить целую колонку из таблицы (не путать с clean_source)
- filter_rows — оставить или убрать СТРОКИ по условиям на колонках (не путать с delete_column)
- none — непонятно

Для filter_rows:
- mode: keep (оставить только подходящие) | remove (убрать подходящие)
- combine: and | or
- filters: массив { column, op, value }
- column — ТОЧНОЕ имя из списка headers
- op: eq | ne | contains | starts_with | gt | lt | empty | not_empty
- пример: debit_account eq 58.01.4 AND credit_account eq 76.07.2

Колонки таблицы (выбери source_column ТОЛЬКО из этого списка, точное имя):
${JSON.stringify(headers || [])}

Примеры значений по колонкам:
${JSON.stringify(samplesByHeader || {}, null, 2)}

Недавний диалог (контекст — пользователь может уточнять прошлую команду):
${formatChatHistory(chatHistory)}

Активный фильтр из прошлого шага (если пользователь пишет «а ещё», «только по name=…» — ДОБАВЬ условия к этому, mode=keep):
${activeFilter ? JSON.stringify(activeFilter, null, 2) : '(нет)'}

Для extract укажи extract_fields — массив полей:
- target_column: имя НОВОЙ колонки (латиница, snake_case), например inventory_extracted, date_extracted, address_extracted
- pattern: regex для поиска в тексте ячейки (JavaScript), экранируй обратным слэшем
- field: inventory | date | address | other
- description: кратко по-русски

Типовые паттерны:
- дата dd.mm.yyyy: \\\\d{2}\\\\.\\\\d{2}\\\\.\\\\d{4}
- инв. формат 80-560482: 80-\\\\d+ (обязательно с префиксом 80-)
- инв. только цифры 8+: \\\\b\\\\d{8,}\\\\b
- адрес после "по адресу": по\\\\s+адресу[^,]+

Для classify заполни auditor_rule текстом правил от пользователя.

Запрос пользователя:
${String(message || '')}

Верни ТОЛЬКО JSON:
{
  "action": "extract|clean_source|classify|delete_column|filter_rows|none",
  "source_column": "имя из списка или null",
  "auditor_rule": "строка или пусто",
  "strip_from_source": true,
  "extract_fields": [{ "target_column": "...", "pattern": "...", "field": "inventory|date|address|other", "description": "..." }],
  "delete_column": "имя колонки или null",
  "mode": "keep|remove",
  "combine": "and|or",
  "filters": [{ "column": "debit_account", "op": "eq", "value": "58.01.4" }],
  "explanation": "1-2 предложения что понял"
}`;
}

function sanitizePlan(raw, headers) {
    const action = ALLOWED_ACTIONS.has(String(raw?.action || '').trim())
        ? String(raw.action).trim()
        : 'none';

    let sourceColumn = String(raw?.source_column || raw?.sourceColumn || '').trim();
    if (sourceColumn && headers?.length && !headers.includes(sourceColumn)) {
        sourceColumn = resolveColumnHint(sourceColumn, headers) || sourceColumn;
    }
    if (sourceColumn && headers?.length && !headers.includes(sourceColumn)) sourceColumn = null;

    let deleteColumn = String(raw?.delete_column || raw?.deleteColumn || '').trim();
    if (deleteColumn && headers?.length && !headers.includes(deleteColumn)) {
        deleteColumn = resolveColumnHint(deleteColumn, headers);
    }

    const extractFields = Array.isArray(raw?.extract_fields)
        ? raw.extract_fields
              .map((f) => ({
                  target_column: String(f?.target_column || f?.targetColumn || '').trim(),
                  pattern: String(f?.pattern || '').trim(),
                  field: String(f?.field || 'other').trim(),
                  description: String(f?.description || '').trim(),
              }))
              .filter((f) => f.target_column && f.pattern)
        : [];

    const filterPlan =
        action === 'filter_rows'
            ? sanitizeFilterPlan(
                  {
                      mode: raw?.mode,
                      combine: raw?.combine,
                      filters: raw?.filters,
                  },
                  headers
              )
            : { mode: 'keep', combine: 'and', filters: [] };

    return {
        action,
        sourceColumn: sourceColumn || null,
        auditorRule: String(raw?.auditor_rule || raw?.auditorRule || '').trim(),
        stripFromSource: Boolean(raw?.strip_from_source ?? raw?.stripFromSource),
        extractFields,
        deleteColumn: deleteColumn || null,
        mode: filterPlan.mode,
        combine: filterPlan.combine,
        filters: filterPlan.filters,
        explanation: String(raw?.explanation || '').trim(),
    };
}

async function planResultTableActionWithLlm({ message, headers, rows, chatHistory, activeFilter }) {
    const samplesByHeader = buildSamplesByHeader(rows, headers, 3);
    const prompt = buildResultTablePlannerPrompt({
        message,
        headers,
        samplesByHeader,
        chatHistory,
        activeFilter,
    });

    const { content } = await chatCompletion({
        messages: [
            { role: 'system', content: 'Отвечай только валидным JSON-объектом.' },
            { role: 'user', content: prompt },
        ],
        temperature: 0.15,
        responseFormat: { type: 'json_object' },
    });

    const parsed = extractJsonFromLlmContent(content);
    return sanitizePlan(parsed, headers);
}

module.exports = {
    planResultTableActionWithLlm,
    pickColumnSamples,
    buildSamplesByHeader,
    sanitizePlan,
};
