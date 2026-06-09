const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findOsvCardHeaderBlock } = require('./excel_column_catalog');
const { walkLevelsStack } = require('./tree_walker');
const { applyTreeProfileToRule } = require('./tree_profiles');

describe('osv card header + outline', () => {
    it('findOsvCardHeaderBlock: легенда дерева в колонке A', () => {
        const data = [
            ['Карточка счета'],
            ['Счет, Наименование счета'],
            ['Подразделение'],
            ['Контрагенты'],
            ['Договоры'],
            ['76, Расчеты'],
        ];
        const block = findOsvCardHeaderBlock(data);
        assert.equal(block.dataStartRow, 5);
        assert.equal(block.hierarchyLegend, true);
    });

    it('полный разворот карточки 76 после шапки', () => {
        const data = [
            ['Счет, Наименование счета'],
            ['Подразделение'],
            ['Контрагенты'],
            ['Договоры'],
            ['76, Расчеты'],
            ['76.01.1, Расчеты'],
            ['Подразделение 1'],
            ['Контрагент10 611'],
            ['Договор 1', 0, 0, 10, 10, 0, 0],
        ];
        const rule = applyTreeProfileToRule(
            {
                rule_schema_version: 2,
                meta: {},
                layout: { layout_type: 'hierarchy_osv', name_column: 0, data_start_row: 4 },
                columns: [],
            },
            'os_76_card'
        );
        const { rows } = walkLevelsStack(data, rule);
        assert.equal(rows.length, 1);
        assert.deepEqual(
            [
                rows[0]['Счёт, наименование счета'],
                rows[0]['Подразделение'],
                rows[0]['Контрагент'],
                rows[0]['Договор'],
            ],
            ['76.01.1, Расчеты', 'Подразделение 1', 'Контрагент10 611', 'Договор 1']
        );
    });
});
