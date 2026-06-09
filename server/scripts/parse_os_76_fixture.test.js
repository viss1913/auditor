const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const xlsx = require('xlsx');
const { findOsvCardHeaderBlock } = require('../excel_column_catalog');
const { applyScenario } = require('../scenarios/registry');
const { runParseEngine } = require('../parse_engine');

function build76CardFixture() {
    const rows = [
        ['Карточка счета 76'],
        ['Организация ООО Тест'],
        [''],
        ['Счет, Наименование счета'],
        ['Подразделение'],
        ['Контрагенты'],
        ['Договоры'],
        ['', 'Сальдо на начало периода', '', 'Обороты за период', '', 'Сальдо на конец периода'],
        ['', 'Дебет', 'Кредит', 'Дебет', 'Кредит', 'Дебет', 'Кредит'],
        ['76, Расчеты с разными дебиторами', 100, 0, 0, 0, 50, 0],
        ['76.01.1, Расчеты по страхованию', 60, 0, 0, 0, 30, 0],
        ['Подразделение 1', 22331, 0, 0, 0, 100, 0],
        ['Контрагент10 611', 0, 0, 1074346, 1074346, 0, 0],
        ['Договор 1', 0, 0, 104010, 104010, 0, 0],
        ['Договор 2', 0, 0, 500000, 500000, 0, 0],
        ['Договор 3', 0, 0, 470336, 470336, 0, 0],
        ['Подразделение 5', 141402, 0, 0, 0, 0, 0],
        ['Контрагент13 596', 0, 0, 0, 0, 0, 0],
        ['Договор 15', 141402, 0, 0, 0, 0, 0],
        ['Договор 16', 0, 0, 10, 10, 0, 0],
    ];
    const tmp = path.join(os.tmpdir(), `os_76_fixture_${Date.now()}.xlsx`);
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Исходная ОСВ');
    xlsx.writeFile(wb, tmp);
    return { tmp, rows };
}

describe('os_76 fixture e2e', () => {
    it('findOsvCardHeaderBlock: не путает Контрагент10 с легендой', () => {
        const { rows } = build76CardFixture();
        const block = findOsvCardHeaderBlock(rows);
        assert.ok(block.dataStartRow >= 7 && block.dataStartRow <= 9);
        assert.match(String(rows[block.dataStartRow][0] || ''), /^76/);
    });

    it('полный parse_engine: 5 договоров', () => {
        const { tmp } = build76CardFixture();
        const buf = fs.readFileSync(tmp);
        const { analyzeLayout } = require('../analyze_layout');
        const layout = analyzeLayout(buf, 'Исходная ОСВ');
        const rule = applyScenario('os_76_account_card', layout, null);
        const out = runParseEngine(tmp, rule);
        assert.equal(out.ok, true);
        const contracts = out.rows.filter((r) => r['Договор']);
        assert.ok(contracts.length >= 5, `ожидали >=5 договоров, получили ${contracts.length}`);
        assert.ok(out.rowCount >= contracts.length, 'есть и итоговые строки без договора');
        assert.match(String(contracts[0]['Счёт, наименование счета'] || ''), /76\.01\.1/);
        assert.equal(contracts[0]['Договор'], 'Договор 1');
        const dogs = out.rows.map((r) => r['Договор']);
        assert.ok(dogs.includes('Договор 15'));
        fs.unlinkSync(tmp);
    });
});
