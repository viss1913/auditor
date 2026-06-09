const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { walkLevelsStack } = require('./tree_walker');
const { applyTreeProfileToRule } = require('./tree_profiles');

function ruleForProfile(profileKey) {
    return applyTreeProfileToRule(
        {
            rule_schema_version: 2,
            meta: { name: 't', source_type: 'excel' },
            layout: { layout_type: 'hierarchy_osv', name_column: 0 },
            columns: [],
        },
        profileKey
    );
}

describe('tree_walker', () => {
    it('os_76_card: договоры с предками в колонках', () => {
        const data = [
            ['76.01.1, Расчеты по имущественному страхованию'],
            ['Подразделение 1'],
            ['Контрагент 10 611'],
            ['Договор 1', 1000, 0, 5, 2, 990, 0],
            ['Договор 2'],
        ];
        const { rows } = walkLevelsStack(data, ruleForProfile('os_76_card'));
        assert.equal(rows.length, 2);
        assert.equal(rows[0]['Договор'], 'Договор 1');
        assert.equal(rows[0]['Подразделение'], 'Подразделение 1');
        assert.equal(rows[0]['Контрагент'], 'Контрагент 10 611');
        assert.equal(
            rows[0]['Счёт, наименование счета'],
            '76.01.1, Расчеты по имущественному страхованию'
        );
    });

    it('os_76_card: много договоров в двух подразделениях', () => {
        const data = [
            ['Счет, Наименование счета'],
            ['Подразделение'],
            ['Контрагенты'],
            ['Договоры'],
            ['76, Расчеты с разными дебиторами'],
            ['76.01.1, Расчеты по страхованию'],
            ['Подразделение 1'],
            ['Контрагент10 611'],
            ['Договор 1', 0, 0, 10, 10],
            ['Договор 2', 0, 0, 20, 20],
            ['Подразделение 5'],
            ['Контрагент13 596'],
            ['Договор 15', 141402, 0, 0, 0],
            ['Договор 16', 0, 0, 5, 5],
        ];
        const rule = ruleForProfile('os_76_card');
        rule.layout.data_start_row = 4;
        const rowOutlineLevels = [0, 0, 0, 0, 1, 2, 3, 4, 5, 5, 3, 4, 5, 5];
        const { rows } = walkLevelsStack(data, rule, { rowOutlineLevels });
        assert.equal(rows.length, 4);
        assert.match(rows[0]['Счёт, наименование счета'], /76\.01\.1/);
        assert.equal(rows[2]['Подразделение'], 'Подразделение 5');
        assert.equal(rows[2]['Договор'], 'Договор 15');
        assert.equal(rows[2]['Сальдо Дт начало'], 141402);
    });

    it('os_76_card: шапка + вложенные счета + outline группировка', () => {
        const data = [
            ['Счет, Наименование счета'],
            ['Подразделение'],
            ['Контрагенты'],
            ['Договоры'],
            ['76, Расчеты с разными дебиторами', 100, 0, 0, 0, 50, 0],
            ['76.01, Расчеты по имущественному', 80, 0, 0, 0, 40, 0],
            ['76.01.1, Расчеты по имущественному страхованию', 60, 0, 0, 0, 30, 0],
            ['Подразделение 1', 22331, 0, 0, 0, 100, 0],
            ['Контрагент10 611', 0, 0, 1074346, 1074346, 0, 0],
            ['Договор 1', 0, 0, 104010, 104010, 0, 0],
            ['Договор 2', 0, 0, 500000, 500000, 0, 0],
            ['Договор 3', 0, 0, 470336, 470336, 0, 0],
        ];
        const rowOutlineLevels = [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6, 6];
        const rule = ruleForProfile('os_76_card');
        rule.layout.data_start_row = 4;
        const { rows } = walkLevelsStack(data, rule, { rowOutlineLevels });
        const contracts = rows.filter((r) => r['Договор']);
        assert.equal(contracts.length, 3);
        assert.equal(contracts[0]['Договор'], 'Договор 1');
        assert.equal(contracts[0]['Контрагент'], 'Контрагент10 611');
        assert.equal(contracts[0]['Подразделение'], 'Подразделение 1');
        assert.match(contracts[0]['Счёт, наименование счета'], /76\.01\.1/);
    });

    it('os_76_card: итоговые строки контрагента с цифрами (не только договоры)', () => {
        const data = [
            ['76.01.1, Счёт'],
            ['Подразделение 1'],
            ['Контрагент10 611', '', '', 1074346.1, 1074346.1],
            ['Договор 1', '', '', 104010.14, 104010.14],
            ['Договор 2', '', '', 334169, 334169],
        ];
        const { rows } = walkLevelsStack(data, ruleForProfile('os_76_card'));
        const contracts = rows.filter((r) => r['Договор']);
        const aggregates = rows.filter((r) => !r['Договор'] && r['Контрагент']);
        assert.equal(contracts.length, 2);
        assert.equal(aggregates.length, 1);
        assert.equal(aggregates[0]['Оборот Дт'], 1074346.1);
    });
});
