'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const xlsx = require('xlsx');

const { smartParseUK } = require('./smart_parse_uk');
const { parseUK } = require('./parse_uk');
const { validateUkRuleJson } = require('./uk_rule_validate');

function buildUkCardSheet() {
    const rows = [];
    for (let i = 0; i < 7; i++) {
        rows.push(['', '', '', '', '', '', '', '', '', '']);
    }
    rows.push(['01.06.2025', '', '', 'Тестовая бумага, 12345678', '', 'БУ', '58.01', '1000.50', '', '76.01']);
    rows.push(['', '', '', '', '', 'Кол.', '', '25', '', '']);
    return rows;
}

function writeTempUkXlsx(rows) {
    const tmp = path.join(os.tmpdir(), `auditor_smart_uk_${Date.now()}.xlsx`);
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    xlsx.writeFile(wb, tmp);
    return tmp;
}

test('validateUkRuleJson: валидное правило', () => {
    const r = validateUkRuleJson({
        conditions: { debit_account: '58.01', credit_account: '76', date_start: '2025-01-01', date_end: '2025-12-31' },
        operation_type: 'Покупка',
    });
    assert.strictEqual(r.ok, true);
});

test('validateUkRuleJson: неверная дата', () => {
    const r = validateUkRuleJson({
        conditions: { date_start: '2025-13-40' },
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => e.includes('date_start')));
});

test('validateUkRuleJson: date_start позже date_end', () => {
    const r = validateUkRuleJson({
        conditions: { date_start: '2025-06-10', date_end: '2025-01-01' },
    });
    assert.strictEqual(r.ok, false);
});

test('smartParseUK: фильтр как у parseUK даёт то же число строк', () => {
    const rows = buildUkCardSheet();
    const tmp = writeTempUkXlsx(rows);
    try {
    const standard = parseUK(tmp);
    const rule = {
        conditions: { debit_account: '58.01', credit_account: '76' },
        operation_type: 'Покупка',
    };
    const smart = smartParseUK(tmp, rule);

    assert.strictEqual(smart.length, standard.length, 'количество записей должно совпадать с parseUK');
    assert.strictEqual(smart.length, 1);
    assert.strictEqual(smart[0].amount, 1000.5);
    assert.strictEqual(smart[0].quantity, 25);
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
});

test('smartParseUK: несовпадение дебета — пусто', () => {
    const rows = buildUkCardSheet();
    const tmp = writeTempUkXlsx(rows);
    try {
    const smart = smartParseUK(tmp, {
        conditions: { debit_account: '99.99', credit_account: '76' },
        operation_type: 'X',
    });
    assert.deepStrictEqual(smart, []);
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
});

test('smartParseUK: дата вне диапазона — пусто', () => {
    const rows = buildUkCardSheet();
    const tmp = writeTempUkXlsx(rows);
    try {
    const smart = smartParseUK(tmp, {
        conditions: { debit_account: '58.01', credit_account: '76', date_start: '2025-07-01', date_end: '2025-12-31' },
        operation_type: 'Покупка',
    });
    assert.deepStrictEqual(smart, []);
    } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
});
