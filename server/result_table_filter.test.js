const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseResultTableCommand } = require('./result_table_commands');
const { applyFilterToRows } = require('./table_row_filter');

const HEADERS = ['debit_account', 'credit_account', 'amount', 'operation_type'];

const OS_HEADERS = [
    'Юрлицо',
    'Счёт',
    'Подразделение',
    'Контрагент',
    'Договор',
    'Объект',
    'Оборот Дт',
];

describe('result_table filter command', () => {
    it('parseResultTableCommand: убрать строки где Контрагент и Договор пусто', () => {
        const cmd = parseResultTableCommand(
            'Убери все строчки где в Колонке Контрагент, в колонке Договор Пусто.',
            OS_HEADERS
        );
        assert.equal(cmd.action, 'filter_rows');
        assert.equal(cmd.mode, 'remove');
        assert.equal(cmd.filters.length, 2);
        assert.deepEqual(
            cmd.filters.map((f) => ({ column: f.column, op: f.op })),
            [
                { column: 'Контрагент', op: 'empty' },
                { column: 'Договор', op: 'empty' },
            ]
        );
    });

    it('applyFilterToRows: remove both empty Контрагент+Договор', () => {
        const rows = [
            { Контрагент: '', Договор: '', 'Оборот Дт': '100' },
            { Контрагент: 'Контрагент10', Договор: '', 'Оборот Дт': '200' },
            { Контрагент: '', Договор: 'Договор 8', 'Оборот Дт': '300' },
            { Контрагент: 'X', Договор: 'Y', 'Оборот Дт': '400' },
        ];
        const cmd = parseResultTableCommand(
            'Убери все строчки где в Колонке Контрагент, в колонке Договор Пусто.',
            OS_HEADERS
        );
        const result = applyFilterToRows(rows, cmd);
        assert.equal(result.kept, 3);
        assert.equal(result.removed, 1);
        assert.equal(result.rows[0]['Оборот Дт'], '200');
        assert.ok(!result.rows.some((r) => !r.Контрагент && !r.Договор));
    });

    it('parseResultTableCommand: номер из колонки Контрагент', () => {
        const cmd = parseResultTableCommand(
            'в колонке Контрагент проверь ячейки и перенеси номер если встретишь в новую колонку',
            OS_HEADERS
        );
        assert.equal(cmd.action, 'extract');
        assert.equal(cmd.sourceColumn, 'Контрагент');
        assert.equal(cmd.extractFields?.length, 1);
        assert.equal(cmd.extractFields[0].target_column, 'contragent_number');
    });

    it('parseResultTableCommand распознаёт filter_rows', () => {
        const cmd = parseResultTableCommand(
            'сделай фильтр и оставь строчки только если debit_account=58.01.4 и credit_account=76.07.2',
            HEADERS
        );
        assert.equal(cmd.action, 'filter_rows');
        assert.equal(cmd.filters.length, 2);
    });
});
