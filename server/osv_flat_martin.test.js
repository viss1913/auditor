const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseOsvFlatSheet } = require('./osv_flat_martin');

const FIXTURE = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('osv_flat_martin', () => {
    it('Обработанная ОСВ: плоские колонки с контрагентом и договором', () => {
        const buf = fs.readFileSync(FIXTURE);
        const parsed = parseOsvFlatSheet(buf, 'Обработанная ОСВ');
        assert.ok(parsed);
        assert.equal(parsed.rows.length, 15);
        assert.equal(parsed.rows[0]['Подразделение'], 'Подразделение 1');
        assert.equal(parsed.rows[0]['Контрагент'], 'Контрагент10 611');
        assert.equal(parsed.rows[0]['Договор'], 'Договор 1');
        assert.equal(parsed.rows[0]['Оборот Дт'], '104010.14');
        const row5 = parsed.rows.find((r) => r['Договор'] === 'Договор 5');
        assert.ok(row5);
        assert.equal(row5['Сальдо Дт конец'], '888930.82');
    });
});
