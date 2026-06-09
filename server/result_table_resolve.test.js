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
});
