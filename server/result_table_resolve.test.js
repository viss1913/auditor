const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeResultTableCommand } = require('./result_table_resolve');
const { parseResultTableCommand } = require('./result_table_commands');

describe('mergeResultTableCommand', () => {
    const headers = ['ОС'];

    it('clean_source: не отдаёт приоритет LLM extract без strip', () => {
        const regexCmd = parseResultTableCommand('убери из колонки ОС номер и дату', headers);
        const cmd = mergeResultTableCommand({
            message: 'убери из колонки ОС номер и дату',
            headers,
            plan: { action: 'extract', sourceColumn: 'ОС', stripFromSource: false, extractFields: [] },
            regexCmd,
        });
        assert.equal(cmd.action, 'clean_source');
        assert.equal(cmd.stripFromSource, true);
        assert.equal(cmd.extractFields[0].field, 'inventory');
    });

    it('delete_column: LLM не перебивает regex', () => {
        const h = ['period', 'document', 'name'];
        const regexCmd = parseResultTableCommand('удали колонку document', h);
        const cmd = mergeResultTableCommand({
            message: 'удали колонку document',
            headers: h,
            plan: {
                action: 'none',
                explanation: 'Подтверди drop column "document"',
            },
            regexCmd,
        });
        assert.equal(cmd.action, 'delete_column');
        assert.equal(cmd.sourceColumn, 'document');
        assert.equal(cmd.planner, 'regex');
    });
});
