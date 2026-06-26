const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { inferTableMeta, excelColumnLetter, isWideMeasureHeader } = require('./table_meta');

describe('table_meta', () => {
    it('excelColumnLetter: A, B, Z, AA', () => {
        assert.equal(excelColumnLetter(0), 'A');
        assert.equal(excelColumnLetter(1), 'B');
        assert.equal(excelColumnLetter(25), 'Z');
        assert.equal(excelColumnLetter(26), 'AA');
    });

    it('inferTableMeta: uk_osv_wide', () => {
        const headers = [
            'Фонд',
            'Счёт',
            'Наименование',
            'Валюта',
            'Сальдо на начало периода / Дебет / БУ',
            'Сальдо на начало периода / Дебет / Кол.',
        ];
        assert.ok(headers.every((h, i) => i < 4 || isWideMeasureHeader(h)));
        const meta = inferTableMeta(headers, 'uk_osv_58');
        assert.equal(meta.tableLayout, 'uk_osv_wide');
        assert.equal(meta.headerLevels, 3);
        assert.equal(meta.aiHints.scenarioId, 'uk_osv_58');
        assert.equal(meta.measureGroups.length, 2);
        assert.equal(meta.columnLetters[0], 'A');
    });

    it('inferTableMeta: flat fallback', () => {
        const meta = inferTableMeta(['A', 'B', 'C'], 'os_01_flat');
        assert.equal(meta.tableLayout, 'flat');
        assert.equal(meta.excelGrid, true);
    });
});
