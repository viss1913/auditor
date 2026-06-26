const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');

const { sanitizeTableQueryPlan } = require('./table_query_engine');

const { parseAggregateClauses, detectOpFromText, normalizeText } = require('./table_query_clauses');



function pickColumnSamples(rows, headers, limitPerCol = 3) {

    const samples = {};

    for (const h of headers || []) {

        const vals = [];

        for (const row of rows || []) {

            const v = String((row && row[h]) ?? '').trim();

            if (!v || vals.includes(v)) continue;

            vals.push(v);

            if (vals.length >= limitPerCol) break;

        }

        samples[h] = vals;

    }

    return samples;

}



function formatChatHistory(chatHistory, limit = 6) {

    const items = (chatHistory || [])

        .filter((m) => m?.content && (m.role === 'user' || m.role === 'assistant'))

        .slice(-limit);

    if (!items.length) return '(нет)';

    return items.map((m) => `${m.role}: ${String(m.content).slice(0, 300)}`).join('\n');

}



function isAggregateIntent(text) {

    const t = normalizeText(text);

    if (detectOpFromText(text)) return true;

    if (/сколько|посчитай|посчит|итого|сумм|средн|миним|максим|непуст/.test(t)) return true;

    if (/(?:^|\s)по\s+/.test(t) && /сальдо|оборот|сумм|колонк|подраздел|контрагент|договор/.test(t)) {

        return true;

    }

    return false;

}



function parseAggregateIntentRegex(text, headers, samplesByHeader = {}) {

    if (!isAggregateIntent(text)) return null;



    const clauses = parseAggregateClauses(text, headers, samplesByHeader);

    if (clauses.uncertain) return null;



    const { op, column, groupBy, filters, mode, combine } = clauses;

    if (op !== 'count' && !column) return null;



    const raw = {

        action: 'aggregate',

        op,

        column: column || null,

        groupBy: groupBy || null,

        filters,

        mode,

        combine,

    };



    const sanitized = sanitizeTableQueryPlan(raw, headers);

    if (!sanitized.ok) return null;

    return { plan: sanitized.plan, planner: 'regex' };

}



function buildTableQueryPlannerPrompt({ message, headers, samplesByHeader, chatHistory }) {

    return `Ты — Martin. Пользователь спрашивает про ДАННЫЕ уже разобранной таблицы.

Верни план расчёта на сервере (НЕ считай сам).



Допустимые op: sum, count, count_non_empty, min, max, avg

action: aggregate | none



Колонки (точные имена):

${JSON.stringify(headers || [])}



Примеры значений:

${JSON.stringify(samplesByHeader || {}, null, 2)}



Диалог:

${formatChatHistory(chatHistory)}



Примеры:

- "по сальдо дт начало" → sum, column "Сальдо Дт начало", filters: []

- "сколько строк" → count, column null

- "сумма по подразделению 2 и оборот дт" → sum, column "Оборот Дт", filters: [{column:"Подразделение", op:"eq", value:"Подразделение 2"}]
- "по подразделению 4 всего оборотов по дт" → sum, column "Оборот Дт", filters: [{column:"Подразделение", op:"eq", value:"Подразделение 4"}]

- "по каждому контрагенту сумма оборот дт" → sum, column "Оборот Дт", group_by "Контрагент", filters: []

- "debit_account=58.01.4 и сумма amount" → sum, column "amount", filters: [{column:"debit_account", op:"eq", value:"58.01.4"}]

- "привет" → action none



filters: массив { column, op, value } — op: eq, contains, starts_with, gt, lt и т.д.



Запрос: ${String(message || '')}



Верни ТОЛЬКО JSON:

{

  "action": "aggregate|none",

  "op": "sum|count|count_non_empty|min|max|avg",

  "column": "точное имя или null",

  "group_by": "точное имя или null",

  "filters": [],

  "mode": "keep",

  "combine": "and",

  "explanation": "кратко"

}`;

}



async function planTableQueryWithLlm({ message, headers, rows, chatHistory }) {

    const samplesByHeader = pickColumnSamples(rows, headers, 3);

    const prompt = buildTableQueryPlannerPrompt({ message, headers, samplesByHeader, chatHistory });

    const { content } = await chatCompletion({

        messages: [{ role: 'user', content: prompt }],

        temperature: 0.1,

    });

    const raw = extractJsonFromLlmContent(content);

    if (!raw || String(raw.action || '').trim() === 'none') {

        return { plan: null, planner: 'llm' };

    }

    const sanitized = sanitizeTableQueryPlan(

        {

            action: raw.action,

            op: raw.op,

            column: raw.column,

            groupBy: raw.group_by || raw.groupBy,

            filters: raw.filters,

            mode: raw.mode,

            combine: raw.combine,

            limit: raw.limit,

        },

        headers

    );

    if (!sanitized.ok) return { plan: null, planner: 'llm', errors: sanitized.errors };

    return { plan: sanitized.plan, planner: 'llm' };

}



async function planTableQuery({ message, headers, rows, chatHistory, useLlm = true }) {

    const samplesByHeader = pickColumnSamples(rows, headers, 3);

    const regexPlan = parseAggregateIntentRegex(message, headers, samplesByHeader);

    if (regexPlan?.plan) return regexPlan;



    if (!useLlm || !isAggregateIntent(message)) {

        return { plan: null, planner: 'none' };

    }



    try {

        return await planTableQueryWithLlm({ message, headers, rows, chatHistory });

    } catch {

        return { plan: null, planner: 'none' };

    }

}



module.exports = {

    isAggregateIntent,

    parseAggregateIntentRegex,

    planTableQuery,

    pickColumnSamples,

};


