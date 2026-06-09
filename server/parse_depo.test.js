const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseDepoLines, extractAccountFromFilename } = require('./parse_depo');

describe('parse_depo', () => {
    it('extractAccountFromFilename из скобок', () => {
        assert.equal(extractAccountFromFilename('Выписка (30).pdf'), '30');
    });

    it('extractAccountFromFilename fallback по цифрам в скобках', () => {
        assert.equal(extractAccountFromFilename('report (55).pdf'), '55');
    });

    it('parseDepoLines: зачисление ЦБ с ISIN', () => {
        const lines = [
            'ПАО Сбербанк',
            '(Наименование эмитента, тип ценных бумаг)',
            'RU0009029540',
            '(Номер гос. регистрации выпуска/ISIN-код/номер ПДУ/Номер закладной)',
            '01.03.2024',
            'Зачисление ЦБ',
            '100 Отчет N 123',
        ];
        const rows = parseDepoLines(lines, 'test (55).pdf');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].operationType, 'Зачисление ЦБ');
        assert.equal(rows[0].period, '01.03.2024');
        assert.equal(rows[0].debit_account, '55');
        assert.equal(rows[0].isin, 'RU0009029540');
        assert.equal(rows[0].quantity, 100);
    });

    it('parseDepoLines: списание с regNum', () => {
        const lines = [
            'ОФЗ 26207',
            '(Наименование эмитента, тип ценных бумаг)',
            '26207RMFS',
            '(Номер гос. регистрации выпуска/ISIN-код/номер ПДУ/Номер закладной)',
            '15.06.2024',
            'Списание ЦБ',
            '50 Отчет № 99',
        ];
        const rows = parseDepoLines(lines, 'depo (12).pdf');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].operationType, 'Списание ЦБ');
        assert.equal(rows[0].regNum, '26207RMFS');
        assert.equal(rows[0].quantity, 50);
    });
});
