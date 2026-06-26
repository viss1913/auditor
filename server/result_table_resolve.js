const { parseResultTableCommand } = require('./result_table_commands');
const { defaultExtractFields, inferExtractFieldsFromMessage } = require('./cell_enrich');
const { isSplitToTableIntent, parseSplitToTableIntent } = require('./table_row_filter');

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
        extractFields: regexCmd.extractFields || [],
        column: regexCmd.column,
        mappings: regexCmd.mappings || [],
        tableLabel: regexCmd.tableLabel || null,
        explanation: '',
        planner: 'regex',
    };

    const wantsSplit = isSplitToTableIntent(message);

    if (wantsSplit) {
        const splitFromRegex = parseSplitToTableIntent(message, headers);
        const filters =
            (regexCmd.filters?.length ? regexCmd.filters : null) ||
            (plan?.filters?.length ? plan.filters : null) ||
            (splitFromRegex.filters?.length ? splitFromRegex.filters : null) ||
            [];
        return {
            ...cmd,
            action: 'split_to_table',
            tableLabel:
                regexCmd.tableLabel ||
                splitFromRegex.tableLabel ||
                plan?.tableLabel ||
                plan?.table_label ||
                null,
            mode: regexCmd.mode || plan?.mode || splitFromRegex.mode || 'keep',
            combine: regexCmd.combine || plan?.combine || splitFromRegex.combine || 'and',
            filters,
            explanation: plan?.explanation || '',
            planner: regexCmd.filters?.length
                ? 'regex'
                : plan?.filters?.length
                  ? 'llm'
                  : splitFromRegex.filters?.length
                    ? 'regex'
                    : 'regex',
        };
    }

    if (regexCmd.action === 'split_to_table') {
        return {
            ...cmd,
            action: 'split_to_table',
            tableLabel: regexCmd.tableLabel || plan?.tableLabel || plan?.table_label || null,
            mode: regexCmd.mode || plan?.mode || 'keep',
            combine: regexCmd.combine || plan?.combine || 'and',
            filters: regexCmd.filters?.length ? regexCmd.filters : plan?.filters || [],
            explanation: plan?.explanation || regexCmd.explanation || '',
            planner: regexCmd.filters?.length ? 'regex' : plan?.filters?.length ? 'llm' : 'regex',
        };
    }

    if (wantsSplit && plan?.filters?.length) {
        return {
            ...cmd,
            action: 'split_to_table',
            tableLabel: regexCmd.tableLabel || plan.tableLabel || plan.table_label || null,
            mode: plan.mode || 'keep',
            combine: plan.combine || 'and',
            filters: plan.filters,
            explanation: plan.explanation || '',
            planner: 'llm',
        };
    }

    if (regexCmd.action === 'replace_values' && regexCmd.mappings?.length) {
        return {
            ...cmd,
            action: 'replace_values',
            column: regexCmd.column,
            mappings: regexCmd.mappings,
            planner: 'regex',
        };
    }

    if (
        regexCmd.action &&
        [
            'expand_ks_analytics',
            'move_column',
            'rename_column',
            'add_column',
            'fill_column',
            'strip_fill_source',
            'duplicate_column',
            'undo_last',
            'delete_column',
        ].includes(regexCmd.action)
    ) {
        return {
            ...cmd,
            action: regexCmd.action,
            sourceColumn: regexCmd.sourceColumn,
            deleteColumn: regexCmd.sourceColumn || regexCmd.deleteColumn,
            afterColumn: regexCmd.afterColumn,
            position: regexCmd.position,
            newColumnName: regexCmd.newColumnName,
            defaultValue: regexCmd.defaultValue,
            fillFromColumn: regexCmd.fillFromColumn,
            fillTemplate: regexCmd.fillTemplate,
            containsRules: regexCmd.containsRules,
            stripFillFromSource: regexCmd.stripFillFromSource,
            rawFillColumnHint: regexCmd.rawFillColumnHint,
            rawAfterHint: regexCmd.rawAfterHint,
            planner: 'regex',
        };
    }

    if (plan?.action === 'split_to_table' && plan.filters?.length) {
        cmd.action = 'split_to_table';
        cmd.tableLabel = plan.tableLabel || plan.table_label || cmd.tableLabel;
        cmd.mode = plan.mode || cmd.mode;
        cmd.combine = plan.combine || cmd.combine;
        cmd.filters = plan.filters;
        cmd.explanation = plan.explanation || cmd.explanation;
        cmd.planner = regexCmd.filters?.length ? 'regex+llm' : 'llm';
    } else if (plan?.action === 'filter_rows' && plan.filters?.length && !wantsSplit) {
        cmd.action = 'filter_rows';
        cmd.mode = plan.mode || cmd.mode;
        cmd.combine = plan.combine || cmd.combine;
        cmd.filters = regexCmd.filters?.length ? regexCmd.filters : plan.filters;
        cmd.explanation = plan.explanation || cmd.explanation;
        cmd.planner = regexCmd.filters?.length ? 'regex+llm' : 'llm';
    } else if (
        plan?.action &&
        plan.action !== 'none' &&
        !wantsSplit &&
        !regexCmd.stripFromSource &&
        regexCmd.action !== 'clean_source'
    ) {
        cmd.action = plan.action;
        cmd.sourceColumn = plan.sourceColumn || cmd.sourceColumn;
        cmd.auditorRule = plan.auditorRule || cmd.auditorRule;
        cmd.extractFields = plan.extractFields || [];
        cmd.stripFromSource = Boolean(plan.stripFromSource);
        cmd.afterColumn = plan.afterColumn || cmd.afterColumn;
        cmd.position = plan.position || cmd.position;
        cmd.newColumnName = plan.newColumnName || cmd.newColumnName;
        cmd.column = plan.column || cmd.column;
        cmd.mappings = plan.mappings?.length ? plan.mappings : cmd.mappings;
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
    } else if (plan?.action && plan.action !== 'none' && !wantsSplit) {
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
        cmd.extractFields =
            regexCmd.extractFields?.length > 0
                ? regexCmd.extractFields
                : inferExtractFieldsFromMessage(message);
        cmd.planner = cmd.planner + '+fixed-fields';
    }

    if (
        cmd.action === 'extract' &&
        /контрагент/i.test(String(cmd.sourceColumn || '')) &&
        /номер/i.test(message) &&
        !cmd.extractFields?.length
    ) {
        cmd.extractFields = defaultCounterpartyNumberFields();
        cmd.planner = `${cmd.planner}+counterparty-fields`;
    }

    if (regexCmd.extractFields?.length && (cmd.action === 'extract' || cmd.action === 'clean_source')) {
        cmd.extractFields = regexCmd.extractFields;
        cmd.planner = `${cmd.planner}+regex-fields`;
    }

    return cmd;
}

module.exports = { mergeResultTableCommand, wantsInventoryAndDate };
