const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    parseFilterIntent,
    applyFilterToRows,
    buildFilterDeleteQuery,
    sanitizeFilterPlan,
    matchesDimensionValue,
    rowMatchesFilter,
    mergeFilterPlans,
} = require('./table_row_filter');

const UK_HEADERS = [
    'period',
    'document',
    'operation_type',
    'name',
    'regNum',
    'quantity',
    'amount',
    'debit_account',
    'credit_account',
];

const UK_ROWS = [
    {
        period: '30.12.2024',
        name: 'Мечел, ап, 2-01-55005-E',
        operation_type: 'Поступление ц/б',
        amount: 1083.5,
        quantity: 10,
        debit_account: '58.01.4',
        credit_account: '76.07.2',
    },
    {
        period: '30.12.2024',
        name: 'Мечел, ап, 2-01-55005-E',
        operation_type: 'Переоценка завершенных сделок',
        amount: 61,
        quantity: 0,
        debit_account: '58.01.4',
        credit_account: '91.01.10',
    },
    {
        period: '30.12.2024',
        name: 'Мечел, ап, 2-01-55005-E',
        operation_type: 'Поступление ц/б',
        amount: 97515,
        quantity: 5,
        debit_account: '58.01.4',
        credit_account: '76.07.2',
    },
];

describe('table_row_filter', () => {
    it('parseFilterIntent: debit_account + credit_account из фразы', () => {
        const cmd = parseFilterIntent(
            'оставь только строки где debit_account=58.01.4 и credit_account=76.07.2',
            UK_HEADERS
        );
        assert.equal(cmd.action, 'filter_rows');
        assert.equal(cmd.mode, 'keep');
        assert.equal(cmd.filters.length, 2);
        assert.equal(cmd.filters[0].column, 'debit_account');
        assert.equal(cmd.filters[0].value, '58.01.4');
        assert.equal(cmd.filters[1].column, 'credit_account');
        assert.equal(cmd.filters[1].value, '76.07.2');
    });

    it('parseFilterIntent: «только по debit… и credit…» без склейки значений', () => {
        const cmd = parseFilterIntent(
            'а можем фильтр сделать только по debit_account=58.01.4 и credit_account=76.07.2',
            UK_HEADERS
        );
        assert.equal(cmd.filters.length, 2);
        assert.deepEqual(
            cmd.filters.map((f) => `${f.column}=${f.value}`),
            ['debit_account=58.01.4', 'credit_account=76.07.2']
        );
    });

    it('applyFilterToRows: keep 58.01.4 + 76.07.2 → 2 строки', () => {
        const out = applyFilterToRows(UK_ROWS, {
            mode: 'keep',
            combine: 'and',
            filters: [
                { column: 'debit_account', op: 'eq', value: '58.01.4' },
                { column: 'credit_account', op: 'eq', value: '76.07.2' },
            ],
        });
        assert.equal(out.kept, 2);
        assert.equal(out.removed, 1);
        assert.ok(!out.rows.some((r) => r.credit_account.startsWith('91')));
    });

    it('applyFilterToRows: remove credit 91', () => {
        const out = applyFilterToRows(UK_ROWS, {
            mode: 'remove',
            combine: 'and',
            filters: [{ column: 'credit_account', op: 'starts_with', value: '91' }],
        });
        assert.equal(out.kept, 2);
        assert.equal(out.removed, 1);
    });

    it('buildFilterDeleteQuery: кириллические empty-фильтры', () => {
        const osHeaders = ['Контрагент', 'Договор', 'Оборот Дт'];
        const { sql, plan } = buildFilterDeleteQuery(
            7,
            {
                mode: 'remove',
                filters: [
                    { column: 'Контрагент', op: 'empty' },
                    { column: 'Договор', op: 'empty' },
                ],
            },
            osHeaders
        );
        assert.ok(sql);
        assert.equal(plan.filters.length, 2);
        assert.ok(sql.includes("data->>'Контрагент'"));
        assert.ok(sql.includes("data->>'Договор'"));
    });

    it('buildFilterDeleteQuery: SQL с snapshot_id', () => {
        const { sql, params, plan } = buildFilterDeleteQuery(42, {
            mode: 'keep',
            filters: [
                { column: 'debit_account', op: 'eq', value: '58.01.4' },
                { column: 'credit_account', op: 'eq', value: '76.07.2' },
            ],
        });
        assert.ok(sql.includes('DELETE FROM parsed_rows'));
        assert.equal(params[0], 42);
        assert.equal(plan.filters.length, 2);
    });

    it('parseFilterIntent: name=Мечел, ап (с запятой)', () => {
        const cmd = parseFilterIntent('а еще тогда только по name=Мечел, ап', UK_HEADERS);
        assert.equal(cmd.action, 'filter_rows');
        assert.equal(cmd.continuation, true);
        assert.equal(cmd.filters.length, 1);
        assert.equal(cmd.filters[0].column, 'name');
        assert.equal(cmd.filters[0].value, 'Мечел, ап');
        assert.equal(cmd.filters[0].op, 'contains');
    });

    it('mergeFilterPlans: дополняет прошлый фильтр', () => {
        const merged = mergeFilterPlans(
            {
                mode: 'keep',
                filters: [
                    { column: 'debit_account', op: 'eq', value: '58.01.4' },
                    { column: 'credit_account', op: 'eq', value: '76.07.2' },
                ],
            },
            {
                mode: 'keep',
                filters: [{ column: 'name', op: 'contains', value: 'Мечел, ап' }],
            }
        );
        assert.equal(merged.filters.length, 3);
    });

    it('applyFilterToRows: name contains Мечел, ап', () => {
        const out = applyFilterToRows(UK_ROWS, {
            mode: 'keep',
            filters: [{ column: 'name', op: 'contains', value: 'Мечел, ап' }],
        });
        assert.equal(out.kept, 3);
        const merged = applyFilterToRows(out.rows, {
            mode: 'keep',
            combine: 'and',
            filters: [
                { column: 'debit_account', op: 'eq', value: '58.01.4' },
                { column: 'credit_account', op: 'eq', value: '76.07.2' },
                { column: 'name', op: 'contains', value: 'Мечел, ап' },
            ],
        });
        assert.equal(merged.kept, 2);
    });

    it('matchesDimensionValue: «4» не матчит Подразделение 14', () => {
        assert.equal(matchesDimensionValue('Подразделение 4', '4'), true);
        assert.equal(matchesDimensionValue('Подразделение 14', '4'), false);
        assert.equal(matchesDimensionValue('Подразделение 24', '4'), false);
        assert.equal(
            rowMatchesFilter(
                { Подразделение: 'Подразделение 4' },
                { column: 'Подразделение', op: 'eq', value: '4' }
            ),
            true
        );
    });

    it('sanitizeFilterPlan отсекает неизвестные колонки', () => {
        const plan = sanitizeFilterPlan(
            {
                filters: [
                    { column: 'debit_account', op: 'eq', value: '58.01.4' },
                    { column: 'несуществует', op: 'eq', value: 'x' },
                ],
            },
            UK_HEADERS
        );
        assert.equal(plan.filters.length, 1);
    });

    it('parseFilterIntent: оставь строки где есть значение в колонке Объект', () => {
        const headers = ['Группа', 'Подразделение', 'Объект', 'ОС'];
        const cmd = parseFilterIntent(
            'оставь строки только там где есть значение в колонке Объект',
            headers
        );
        assert.equal(cmd.action, 'filter_rows');
        assert.equal(cmd.mode, 'keep');
        assert.equal(cmd.filters.length, 1);
        assert.equal(cmd.filters[0].column, 'Объект');
        assert.equal(cmd.filters[0].op, 'not_empty');
    });

    it('parseFilterIntent: где Объект не пусто', () => {
        const headers = ['Группа', 'Объект', 'ОС'];
        const cmd = parseFilterIntent('оставь только строки где Объект не пусто', headers);
        assert.equal(cmd.filters.length, 1);
        assert.equal(cmd.filters[0].column, 'Объект');
        assert.equal(cmd.filters[0].op, 'not_empty');
    });

    it('applyFilterToRows: keep not_empty Объект', () => {
        const rows = [
            { Объект: '80-001', ОС: 'Стол' },
            { Объект: '', ОС: 'Стул' },
            { Объект: '80-002', ОС: 'Шкаф' },
        ];
        const out = applyFilterToRows(rows, {
            mode: 'keep',
            filters: [{ column: 'Объект', op: 'not_empty' }],
        });
        assert.equal(out.kept, 2);
        assert.equal(out.removed, 1);
        assert.ok(!out.rows.some((r) => !String(r['Объект'] || '').trim()));
    });
});
