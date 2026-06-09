const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseResultTableCommand } = require('./result_table_commands');

const HEADERS = ['debit_account', 'credit_account', 'amount', 'operation_type'];

describe('result_table filter command', () => {
    it('parseResultTableCommand распознаёт filter_rows', () => {
        const cmd = parseResultTableCommand(
            'сделай фильтр и оставь строчки только если debit_account=58.01.4 и credit_account=76.07.2',
            HEADERS
        );
        assert.equal(cmd.action, 'filter_rows');
        assert.equal(cmd.filters.length, 2);
    });
});
