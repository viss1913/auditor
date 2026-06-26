const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');
const { resolveColumnHint } = require('./result_table_commands');

const { sanitizeFilterPlan } = require('./table_row_filter');

const ALLOWED_ACTIONS = new Set([
    'extract',
    'classify',
    'delete_column',
    'clean_source',
    'filter_rows',
    'split_to_table',
    'replace_values',
    'expand_ks_analytics',
    'move_column',
    'rename_column',
    'add_column',
    'duplicate_column',
    'undo_last',
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
- filter_rows — оставить или убрать СТРОКИ по условиям на колонках В ТЕКУЩЕЙ таблице (исходные строки удаляются)
- split_to_table — создать НОВУЮ вкладку/таблицу с подмножеством строк; исходная таблица НЕ меняется (если пользователь просит «новую таблицу», «вкладку», «перенеси в новую»)
- replace_values — заменить значения в колонке по правилам (например operationType: Списание ЦБ → продажа)
- expand_ks_analytics — раскрыть composite-колонки «Аналитика Дт/Кт» в плоские поля
- move_column — переставить колонку (после/перед другой)
- rename_column — переименовать колонку
- add_column — добавить колонку; new_column_name — отображаемое имя из запроса (например «Тип сделки», НЕ operation_type_classified); after_column + position after|before — вставить рядом с якорем
- Если просят «Тип сделки» / «поступление ц/б → покупка» по operation_type — action add_column или fill_column, new_column_name: «Тип сделки», fill из operation_type через containsRules в explanation, НЕ classify и НЕ extract_fields
- duplicate_column — скопировать колонку под новым именем
- undo_last — отменить последнюю операцию (filter_rows или delete_column)
- none — непонятно

Для split_to_table укажи table_label — короткое имя новой вкладки (например «ВТБ»).
Условия отбора строк — те же filters/mode/combine, что и для filter_rows.

Для filter_rows:
- mode: keep (оставить только подходящие) | remove (убрать подходящие)
- combine: and | or
- filters: массив { column, op, value }
- column — ТОЧНОЕ имя из списка headers
- op: eq | ne | contains | starts_with | gt | lt | empty | not_empty
- пример: debit_account eq 58.01.4 AND credit_account eq 76.07.2
- «убери строки где контрагент и договор пусто» → mode remove, filters: [{column:"Контрагент",op:"empty"},{column:"Договор",op:"empty"}], combine and
- «оставь строки только там где есть значение в колонке Объект» → mode keep, filters: [{column:"Объект",op:"not_empty"}]
- «где Объект не пусто» → mode keep, filters: [{column:"Объект",op:"not_empty"}]

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

Примеры add_column:
- «надо создать колонку после document, назови Тип сделки» → action add_column, new_column_name: "Тип сделки", after_column: "document", position: "after"
- «добавь колонку Комментарий» → action add_column, new_column_name: "Комментарий"

Запрос пользователя:
${String(message || '')}

Верни ТОЛЬКО JSON:
{
  "action": "extract|clean_source|classify|delete_column|filter_rows|split_to_table|replace_values|expand_ks_analytics|move_column|rename_column|add_column|duplicate_column|undo_last|none",
  "table_label": "имя новой вкладки или null",
  "source_column": "имя из списка или null",
  "after_column": "якорная колонка для move_column или null",
  "position": "after|before",
  "new_column_name": "новое имя колонки или null",
  "column": "колонка для replace_values",
  "mappings": [{ "from": "старое", "to": "новое" }],
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

    let afterColumn = String(raw?.after_column || raw?.afterColumn || '').trim();
    if (afterColumn && headers?.length && !headers.includes(afterColumn)) {
        afterColumn = resolveColumnHint(afterColumn, headers) || null;
    }
    if (afterColumn && headers?.length && !headers.includes(afterColumn)) afterColumn = null;

    let newColumnName = String(raw?.new_column_name || raw?.newColumnName || '').trim() || null;

    let column = String(raw?.column || '').trim();
    if (column && headers?.length && !headers.includes(column)) {
        column = resolveColumnHint(column, headers) || column;
    }
    if (column && headers?.length && !headers.includes(column)) column = null;

    const mappings = Array.isArray(raw?.mappings)
        ? raw.mappings
              .map((m) => ({
                  from: String(m?.from || '').trim(),
                  to: String(m?.to || '').trim(),
              }))
              .filter((m) => m.from && m.to)
        : [];

    const position = /before|перед/i.test(String(raw?.position || '')) ? 'before' : 'after';

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
        action === 'filter_rows' || action === 'split_to_table'
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
        afterColumn: afterColumn || null,
        position,
        newColumnName,
        column: column || null,
        mappings,
        tableLabel: String(raw?.table_label || raw?.tableLabel || '').trim() || null,
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
    buildResultTablePlannerPrompt,
    formatChatHistory,
    sanitizePlan,
};
