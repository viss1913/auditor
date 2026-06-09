const { parseResultTableCommand } = require('./result_table_commands');
const { defaultExtractFields } = require('./cell_enrich');

function wantsInventoryAndDate(message) {
    return /(инвентар|номер|inventory)/i.test(message) && /(дат|date)/i.test(message);
}

function mergeResultTableCommand({ message, headers, plan, regexCmd }) {
    const cmd = {
        action: regexCmd.action,
        sourceColumn: regexCmd.sourceColumn,
        auditorRule: regexCmd.auditorRule || '',
        extractFields: [],
        stripFromSource: Boolean(regexCmd.stripFromSource),
        deleteColumn: regexCmd.deleteColumn,
        rawColumnHint: regexCmd.rawColumnHint,
        mode: regexCmd.mode || 'keep',
        combine: regexCmd.combine || 'and',
        filters: regexCmd.filters || [],
        column: regexCmd.column,
        mappings: regexCmd.mappings || [],
        explanation: '',
        planner: 'regex',
    };

    if (regexCmd.action === 'replace_values' && regexCmd.mappings?.length) {
        return {
            ...cmd,
            action: 'replace_values',
            column: regexCmd.column,
            mappings: regexCmd.mappings,
            planner: 'regex',
        };
    }

    if (plan?.action === 'filter_rows' && plan.filters?.length) {
        cmd.action = 'filter_rows';
        cmd.mode = plan.mode || cmd.mode;
        cmd.combine = plan.combine || cmd.combine;
        cmd.filters = plan.filters;
        cmd.explanation = plan.explanation || cmd.explanation;
        cmd.planner = regexCmd.filters?.length ? 'regex+llm' : 'llm';
    } else if (plan?.action && plan.action !== 'none' && !regexCmd.stripFromSource && regexCmd.action !== 'clean_source') {
        cmd.action = plan.action;
        cmd.sourceColumn = plan.sourceColumn || cmd.sourceColumn;
        cmd.auditorRule = plan.auditorRule || cmd.auditorRule;
        cmd.extractFields = plan.extractFields || [];
        cmd.stripFromSource = Boolean(plan.stripFromSource);
        cmd.explanation = plan.explanation || '';
        cmd.planner = 'llm';
    } else if (plan?.action && plan.action !== 'none' && regexCmd.action === 'clean_source') {
        cmd.action = 'clean_source';
        cmd.sourceColumn = regexCmd.sourceColumn || plan.sourceColumn;
        cmd.stripFromSource = true;
        cmd.explanation = plan.explanation || '';
        cmd.planner = 'regex+llm';
    } else if (plan?.action === 'extract' && (regexCmd.stripFromSource || /убер\S*|удал\S*.*из\s+колонк/i.test(message))) {
        cmd.action = 'extract';
        cmd.sourceColumn = regexCmd.sourceColumn || plan.sourceColumn;
        cmd.stripFromSource = true;
        cmd.extractFields = plan.extractFields?.length ? plan.extractFields : [];
        cmd.explanation = plan.explanation || '';
        cmd.planner = 'llm+strip';
    } else if (plan?.action && plan.action !== 'none') {
        cmd.action = plan.action;
        cmd.sourceColumn = plan.sourceColumn || cmd.sourceColumn;
        cmd.auditorRule = plan.auditorRule || cmd.auditorRule;
        cmd.extractFields = plan.extractFields || [];
        cmd.stripFromSource = Boolean(plan.stripFromSource || regexCmd.stripFromSource);
        cmd.explanation = plan.explanation || '';
        cmd.planner = 'llm';
    }

    if (regexCmd.stripFromSource) {
        cmd.stripFromSource = true;
        if (regexCmd.action === 'clean_source') cmd.action = 'clean_source';
        if (!cmd.sourceColumn) cmd.sourceColumn = regexCmd.sourceColumn;
    }

    if (
        (cmd.action === 'extract' || cmd.action === 'clean_source') &&
        (wantsInventoryAndDate(message) || regexCmd.stripFromSource)
    ) {
        cmd.extractFields = defaultExtractFields();
        cmd.planner = cmd.planner + '+fixed-fields';
    }

    return cmd;
}

module.exports = { mergeResultTableCommand, wantsInventoryAndDate };
