const { parseResultTableCommand } = require('./result_table_commands');
const {
    isFilterContinuation,
    isSplitToTableIntent,
    mergeFilterPlans,
    parseFilterIntent,
    parseSplitToTableIntent,
    extractSplitTableLabel,
} = require('./table_row_filter');
const { mergeResultTableCommand } = require('./result_table_resolve');
const { planResultTableActionWithLlm } = require('./result_table_llm');
const { looksLikeTableMutationIntent } = require('./table_work_intent');

const SNAPSHOT_ONLY_ACTIONS = new Set([
    'replace_values',
    'expand_ks_analytics',
    'move_column',
    'rename_column',
    'add_column',
    'fill_column',
    'strip_fill_source',
    'duplicate_column',
    'delete_column',
    'undo_last',
]);

function buildSkipLlm(message, regexCmd) {
    return (
        regexCmd.action === 'replace_values' ||
        regexCmd.action === 'expand_ks_analytics' ||
        regexCmd.action === 'move_column' ||
        regexCmd.action === 'rename_column' ||
        regexCmd.action === 'add_column' ||
        regexCmd.action === 'fill_column' ||
        (regexCmd.action === 'add_column' && regexCmd.containsRules?.length) ||
        regexCmd.action === 'strip_fill_source' ||
        regexCmd.action === 'duplicate_column' ||
        regexCmd.action === 'delete_column' ||
        regexCmd.action === 'undo_last' ||
        regexCmd.action === 'clean_source' ||
        regexCmd.action === 'clean_source' ||
        regexCmd.stripFromSource ||
        (regexCmd.action === 'split_to_table' && regexCmd.filters?.length) ||
        (regexCmd.action === 'filter_rows' && regexCmd.filters?.length) ||
        (regexCmd.action === 'extract' &&
            regexCmd.extractFields?.length > 0 &&
            (regexCmd.sourceColumn ||
                /сделк|mcxs|дат|инвентар|номер|адрес/i.test(message))) ||
        (regexCmd.action === 'clean_source' && regexCmd.extractFields?.length > 0) ||
        (regexCmd.action === 'extract' &&
            (/(инвентар|номер).*(дат|дату)|(дат|дату).*(инвентар|номер)/i.test(message) ||
                (regexCmd.extractFields?.length > 0 &&
                    /контрагент/i.test(String(regexCmd.sourceColumn || '')))))
    );
}

async function resolveTableCommand({ message, headers, rows = [], options = {} }) {
    const chatHistory = Array.isArray(options.chatHistory) ? options.chatHistory : [];
    const lastFilterOp = options.lastFilterOp || null;

    let regexCmd = parseResultTableCommand(message, headers, chatHistory);
    const continuation =
        regexCmd.continuation ||
        isFilterContinuation(message) ||
        parseFilterIntent(message, headers).continuation;

    if (
        continuation &&
        lastFilterOp?.command?.filters?.length &&
        regexCmd.action === 'filter_rows'
    ) {
        const merged = mergeFilterPlans(lastFilterOp.command, regexCmd);
        regexCmd = {
            ...regexCmd,
            ...merged,
            planner: 'regex+history',
        };
    }

    const skipLlm = buildSkipLlm(message, regexCmd);
    const forceLlm = looksLikeTableMutationIntent(message) && !regexCmd.action;
    let plan = null;

    if (options.useLlm !== false && message && (!skipLlm || forceLlm)) {
        try {
            plan = await planResultTableActionWithLlm({
                message,
                headers,
                rows,
                chatHistory,
                activeFilter: lastFilterOp?.command || null,
            });
        } catch {
            plan = null;
        }
    }

    let command = mergeResultTableCommand({ message, headers, plan, regexCmd });

    if (
        command.action === 'filter_rows' &&
        continuation &&
        lastFilterOp?.command?.filters?.length
    ) {
        command = { ...command, ...mergeFilterPlans(lastFilterOp.command, command) };
    }

    if (command.action === 'filter_rows' && isSplitToTableIntent(message)) {
        const splitHint = parseSplitToTableIntent(message, headers);
        command = {
            ...command,
            action: 'split_to_table',
            tableLabel: command.tableLabel || splitHint.tableLabel || extractSplitTableLabel(message),
            filters: command.filters?.length ? command.filters : splitHint.filters || [],
        };
    }

    const planner = command.planner || (plan ? 'llm' : 'regex');
    const needsSnapshot = SNAPSHOT_ONLY_ACTIONS.has(command.action);

    return { command, planner, regexCmd, plan, needsSnapshot, skipLlm };
}

module.exports = { resolveTableCommand, SNAPSHOT_ONLY_ACTIONS, buildSkipLlm };
