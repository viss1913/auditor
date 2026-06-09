'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { smartParseUK } = require('./smart_parse_uk');

const fixture = path.join(__dirname, 'fixtures', 'uk_sample.xlsx');

test('UK fixture: правило 58.01/76 → 1 запись', () => {
    const rule = {
        conditions: { debit_account: '58.01', credit_account: '76' },
        operation_type: 'Покупка',
    };
    const rows = smartParseUK(fixture, rule);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].quantity, 25);
    assert.strictEqual(rows[0].amount, 1000.5);
});
