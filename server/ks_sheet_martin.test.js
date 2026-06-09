const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseKsSheet, isKsSheetName } = require('./ks_sheet_martin');

const FIXTURE = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('ks_sheet_martin', () => {
    it('isKsSheetName', () => {
        assert.equal(isKsSheetName('Исходная КС'), true);
        assert.equal(isKsSheetName('Обработанная ОСВ'), false);
    });

    it('parseKsSheet: оба листа КС из fixture 76', () => {
        const buf = fs.readFileSync(FIXTURE);
        const flat = parseKsSheet(buf, 'Обработанная КС');
        assert.ok(flat);
        assert.equal(flat.scenarioId, 'ks_card_flat');
        assert.ok(flat.rows.length >= 5);
        assert.equal(flat.rows[0].debit_account, '62.01');
        assert.equal(flat.rows[0].credit_account, '90.01.1');
        assert.equal(flat.rows[0].debit_amount, '');
        assert.equal(String(flat.rows[0].credit_amount), '3263.05');

        const src = parseKsSheet(buf, 'Исходная КС');
        assert.ok(src);
        assert.equal(src.scenarioId, 'ks_card_composite');
        assert.ok(src.rows.length >= 5);
        assert.equal(src.rows[0].counterparty, 'Контрагент 1');
        assert.equal(src.rows[0].credit_amount, '3263.05');
    });
});
