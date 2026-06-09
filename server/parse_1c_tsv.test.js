const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parse1cTsvExport } = require('./parse_1c_tsv');

describe('parse_1c_tsv', () => {
    it('parses multiline quoted fields into logical rows', () => {
        const fixture = path.join(__dirname, '..', 'docs', 'ksenia', 'Необр_4кв.txt');
        if (!fs.existsSync(fixture)) return;

        const result = parse1cTsvExport(fs.readFileSync(fixture), { fileName: 'Необр_4кв.txt' });
        assert.equal(result.ok, true);
        assert.equal(result.profile, 'card_90_tsv');
        assert.ok(result.rowCount >= 100, `expected many rows, got ${result.rowCount}`);
        assert.equal(result.meta.encoding, 'win1251');
        assert.equal(result.headers.includes('Сумма Кт'), true);

        const first = result.rows[0];
        assert.equal(first['Период'], '01.10.2025');
        assert.match(first['Документ'], /Продажа ЦБ 120568797/);
        assert.equal(first['Контрагент'], 'АТОН ООО');
        assert.equal(first['ID сделки'], '703903888');
        assert.match(first['Инструмент'], /Lukoil Capital DAC/);
        assert.ok(first['Сумма Кт'] > 100000000);
    });

    it('parses deals registry sample', () => {
        const fixture = path.join(__dirname, 'fixtures', 'deals_registry_sample.txt');
        const result = parse1cTsvExport(fs.readFileSync(fixture), { fileName: 'реестр_сделок.txt' });
        assert.equal(result.ok, true);
        assert.equal(result.profile, 'deals_registry_tsv');
        assert.equal(result.rowCount, 3);
        assert.equal(result.rows[0]['Номер сделки'], '703903888');
        assert.equal(result.rows[0].Контрагент, 'АТОН ООО');
    });
});
