const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    extractHeaderFields,
    applyHeaderFieldsToRows,
    suggestBrokerHeaderFields,
} = require('./pdf_header_fields');

test('extractHeaderFields pulls client code from header', () => {
    const rows = [
        { text: 'INVESTMENT ACCOUNT STATEMENT — клиент KV-77102' },
        { text: '№ ISIN Тикер' },
        { text: '1 RU0009029540 SBER' },
    ];
    const defs = [
        {
            target: 'client',
            label: 'Клиент',
            pattern: 'клиент\\s+([A-Z0-9-]+)',
            flags: 'i',
            scope: 'above_data_start',
        },
    ];
    const values = extractHeaderFields(rows, 2, defs);
    assert.equal(values['Клиент'], 'KV-77102');
});

test('applyHeaderFieldsToRows adds column to each row', () => {
    const rows = [{ a: '1' }, { a: '2' }];
    const applied = applyHeaderFieldsToRows(
        rows,
        ['a'],
        { Клиент: 'KV-77102' },
        [{ target: 'client', label: 'Клиент', pattern: 'x', scope: 'above_data_start' }]
    );
    assert.ok(applied.headers.includes('Клиент'));
    assert.equal(applied.rows[0]['Клиент'], 'KV-77102');
    assert.equal(applied.rows[1]['Клиент'], 'KV-77102');
});

test('suggestBrokerHeaderFields detects client', () => {
    const rows = [{ text: 'клиент KV-77102' }];
    const s = suggestBrokerHeaderFields(rows);
    assert.ok(s.some((f) => f.label === 'Клиент'));
});

test('suggestBrokerHeaderFields skips УПД for logistics disclaimer', () => {
    const rows = [
        { text: 'Складской реестр отгрузок' },
        { text: 'Внутренний отчёт логистики (не брокер / не депо / не УПД)' },
    ];
    const fields = suggestBrokerHeaderFields(rows);
    assert.equal(fields.some((f) => f.label === 'УПД №'), false);
});
