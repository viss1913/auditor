const { chatCompletion } = require('./llm_client');
const { applyAnswer } = require('./orchestrator/session_plan');
const { resolveAnswerFromText } = require('./orchestrator/answer_resolve');
const { parseResultTableCommand } = require('./result_table_commands');
const { mergeResultTableCommand } = require('./result_table_resolve');
const { planResultTableActionWithLlm } = require('./result_table_llm');
const { applySnapshotOperation } = require('./parse_snapshot_operations');
const { classifyBatchUnique } = require('./cell_enrich');
const { comparePreviewToTarget, loadTargetRows } = require('./compare_target');

const MARTIN_TOOL_SCHEMAS = [
    {
        name: 'answer_question',
        description: 'Ответить на текущий вопрос Martin (сценарий, дерево, колонка)',
        parameters: {
            type: 'object',
            properties: {
                question_id: { type: 'string', description: 'ID вопроса, напр. pick_tree_flatten' },
                answer_text: { type: 'string', description: 'Текст ответа аудитора' },
            },
            required: ['question_id', 'answer_text'],
        },
    },
    {
        name: 'set_file_prefix',
        description: 'Задать префикс файлов для брокера OPIF (например 1F018_)',
        parameters: {
            type: 'object',
            properties: {
                prefix: { type: 'string' },
            },
            required: ['prefix'],
        },
    },
    {
        name: 'filter_table',
        description: 'Отфильтровать строки в текущей таблице',
        parameters: {
            type: 'object',
            properties: {
                filter_expression: { type: 'string', description: 'Условие фильтра на русском' },
            },
            required: ['filter_expression'],
        },
    },
    {
        name: 'extract_column',
        description: 'Извлечь поле из составной колонки (инв.номер, дата)',
        parameters: {
            type: 'object',
            properties: {
                source_column: { type: 'string' },
                field: { type: 'string', enum: ['inventory_number', 'date_ddmmyyyy', 'address'] },
            },
            required: ['source_column', 'field'],
        },
    },
    {
        name: 'classify_column',
        description: 'Классифицировать активы в колонке по правилу аудитора',
        parameters: {
            type: 'object',
            properties: {
                source_column: { type: 'string' },
                auditor_rule: { type: 'string' },
            },
            required: ['source_column'],
        },
    },
    {
        name: 'compare_sources',
        description: 'Сравнить текущую таблицу с эталоном',
        parameters: {
            type: 'object',
            properties: {
                note: { type: 'string' },
            },
        },
    },
];

function isToolsEnabled() {
    return process.env.MARTIN_USE_TOOLS === '1' || process.env.MARTIN_SMART_DIALOG === '1';
}

function parseToolArguments(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

async function executeMartinTool(toolName, args, ctx = {}) {
    const result = { tool: toolName, ok: false, summary: '' };

    if (toolName === 'answer_question') {
        const { question_id, answer_text } = args;
        const question =
            ctx.currentQuestion?.id === question_id
                ? ctx.currentQuestion
                : (ctx.pendingQuestions || []).find((q) => q.id === question_id);
        const resolved = await resolveAnswerFromText({
            userText: answer_text,
            question,
            layoutMeta: ctx.layoutMeta,
        });
        if (!resolved?.value) {
            result.summary = `Не поняла ответ на «${question_id}»`;
            return result;
        }
        result.orchestratorAnswers = {
            ...(ctx.orchestratorAnswers || {}),
            [question_id]: resolved.value,
            ...(question_id === 'pick_scenario' ? { scenarioId: resolved.value } : {}),
            ...(question_id === 'pick_tree_flatten' ? { pick_tree_flatten: resolved.value } : {}),
            ...(question_id === 'pick_uk_quantity_column'
                ? { quantityColumn: Number(resolved.value) }
                : {}),
            ...(question_id === 'pick_merge_strategy'
                ? { mergeStrategy: resolved.value, pick_merge_strategy: resolved.value }
                : {}),
        };
        if (ctx.sessionPlan) {
            result.nextPlan = applyAnswer(ctx.sessionPlan, question_id, resolved.value);
        }
        result.ok = true;
        result.summary = `Ответ на ${question_id}: ${resolved.value}`;
        result.value = resolved.value;
        return result;
    }

    if (toolName === 'set_file_prefix') {
        result.ok = true;
        result.filePrefix = String(args.prefix || '').trim();
        result.summary = `Префикс файлов: ${result.filePrefix}`;
        return result;
    }

    if (toolName === 'filter_table') {
        const headers = ctx.parsePreview?.headers || [];
        const regexPlan = parseResultTableCommand(args.filter_expression, headers);
        const skipLlm = regexPlan?.action === 'filter_rows' && regexPlan?.filters?.length;
        let llmPlan = null;
        if (!skipLlm) {
            llmPlan = await planResultTableActionWithLlm({
                message: args.filter_expression,
                headers,
                rows: ctx.parsePreview?.rows || [],
            }).catch(() => null);
        }
        const plan = mergeResultTableCommand({
            message: args.filter_expression,
            headers,
            plan: llmPlan,
            regexCmd: regexPlan,
        });
        result.ok = plan?.action === 'filter_rows' || plan?.action === 'split_to_table';
        result.plan = plan;

        if (result.ok && ctx.snapshotId && ctx.snapshotStore) {
            const applied = await applySnapshotOperation(ctx.snapshotStore, ctx.snapshotId, {
                message: args.filter_expression,
            });
            if (applied.handled) {
                result.applied = applied;
                result.summary = applied.assistantMessage || `Фильтр: ${args.filter_expression}`;
                return result;
            }
        }

        result.summary = result.ok ? `Фильтр: ${args.filter_expression}` : 'Не удалось разобрать фильтр';
        return result;
    }

    if (toolName === 'extract_column') {
        const msg = `вытащи ${args.field === 'inventory_number' ? 'инвентарный номер' : 'дату'} из колонки ${args.source_column}`;
        const headers = ctx.parsePreview?.headers || [];
        const regexPlan = parseResultTableCommand(msg, headers);
        const llmPlan = await planResultTableActionWithLlm({
            message: msg,
            headers,
            rows: ctx.parsePreview?.rows || [],
        });
        result.plan = mergeResultTableCommand(regexPlan, llmPlan);
        result.ok = Boolean(result.plan?.extract);
        result.summary = result.ok ? `Extract ${args.field} из ${args.source_column}` : 'Extract не разобран';
        return result;
    }

    if (toolName === 'classify_column') {
        const col = args.source_column;
        const headers = ctx.parsePreview?.headers || [];
        const rows = ctx.parsePreview?.rows || [];
        const values = rows.map((r) => r[col]).filter((v) => v != null && String(v).trim());
        const enriched = await classifyBatchUnique(values, args.auditor_rule || '');
        result.ok = enriched.length > 0;
        result.enriched = enriched;
        result.summary = `Классификация ${col}: ${enriched.length} уникальных значений`;
        return result;
    }

    if (toolName === 'compare_sources') {
        if (!ctx.targetBuffer || !ctx.parsePreview) {
            result.summary = 'Нет эталона или превью для сравнения';
            return result;
        }
        const target = loadTargetRows(ctx.targetBuffer);
        const cmp = comparePreviewToTarget(ctx.parsePreview, target);
        result.ok = true;
        result.compare = cmp;
        result.summary = `Совпало: ${cmp.summary?.matched || 0}, расхождений: ${cmp.summary?.mismatchCount || 0}`;
        return result;
    }

    result.summary = `Неизвестный tool: ${toolName}`;
    return result;
}

async function processAiChatWithTools({
    messages,
    context = {},
    maxSteps = 2,
}) {
    if (!isToolsEnabled()) return null;

    const systemPrompt = `Ты Martin — AI-помощник аудитора. Используй tools когда пользователь просит действие (parse, filter, classify, compare, ответ на вопрос).
Контекст сессии в JSON ниже. Если достаточно текста — отвечай без tool.`;

    const ctxJson = JSON.stringify(
        {
            scenarioId: context.scenarioId,
            snapshotId: context.snapshotId,
            currentQuestion: context.currentQuestion,
            headers: context.parsePreview?.headers,
            rowCount: context.parsePreview?.rowCount,
        },
        null,
        0
    );

    const toolResults = [];
    let assistantText = '';

    for (let step = 0; step < maxSteps; step++) {
        const llmMessages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Контекст:\n${ctxJson}` },
            ...(messages || []).slice(-8).map((m) => ({
                role: m.role,
                content: String(m.content || ''),
            })),
        ];

        const { content, tool_calls: toolCalls } = await chatCompletion({
            messages: llmMessages,
            temperature: 0.2,
            tools: MARTIN_TOOL_SCHEMAS,
        });

        if (!toolCalls?.length) {
            assistantText = content || assistantText;
            break;
        }

        for (const call of toolCalls) {
            const args = parseToolArguments(call.function?.arguments);
            const exec = await executeMartinTool(call.function?.name, args, context);
            toolResults.push({
                id: call.id,
                name: call.function?.name,
                arguments: args,
                result: exec,
            });
            if (exec.orchestratorAnswers) {
                context.orchestratorAnswers = exec.orchestratorAnswers;
            }
            if (exec.nextPlan) {
                context.sessionPlan = exec.nextPlan;
                context.currentQuestion = exec.nextPlan.currentQuestion;
            }
            if (exec.filePrefix) {
                context.filePrefix = exec.filePrefix;
            }
        }

        assistantText =
            toolResults.map((t) => `✓ ${t.name}: ${t.result.summary}`).join('\n') +
            (content ? `\n\n${content}` : '');
    }

    return {
        assistantMessage: assistantText,
        toolResults,
        context,
    };
}

module.exports = {
    MARTIN_TOOL_SCHEMAS,
    isToolsEnabled,
    executeMartinTool,
    processAiChatWithTools,
};
