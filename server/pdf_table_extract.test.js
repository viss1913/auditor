const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractPdfTablesFromLines } = require('./universal_parse/pdf_table_extract');

describe('pdf_table_extract', () => {
    it('таб с разделителем табуляции', () => {
        const lines = [
            'Договор №123',
            'Дата\tСумма\tКонтрагент',
            '01.01.2025\t1000\tООО Ромашка',
            '02.01.2025\t2000\tООО Лютик',
        ];
        const out = extractPdfTablesFromLines(lines);
        assert.equal(out.ok, true);
        assert.equal(out.rows.length, 2);
        assert.ok(out.headers.includes('Дата'));
    });

    it('колонки через несколько пробелов', () => {
        const lines = [
            'Позиция    Кол-во    Цена',
            'Болт М8    10    12,50',
            'Гайка М8    20    3,00',
            'Шайба    30    1,00',
        ];
        const out = extractPdfTablesFromLines(lines);
        assert.equal(out.ok, true);
        assert.equal(out.rows.length, 3);
    });
});
