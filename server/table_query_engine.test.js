const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseOsvFlatSheet } = require('./osv_flat_martin');
const {
    sanitizeTableQueryPlan,
    executeTableQueryOnRows,
    formatQueryResultMessage,
    parseNumericCell,
} = require('./table_query_engine');
const { planTableQuery, parseAggregateIntentRegex, pickColumnSamples } = require('./table_query_llm');
const { parseAggregateClauses } = require('./table_query_clauses');
const { sanitizeFilterPlan } = require('./table_row_filter');

const FIXTURE = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('table_query_engine', () => {
    let headers;
    let rows;

    it('prepare fixture Обработанная ОСВ', () => {
        const parsed = parseOsvFlatSheet(fs.readFileSync(FIXTURE), 'Обработанная ОСВ');
        assert.ok(parsed?.rows?.length);
        headers = parsed.headers;
        rows = parsed.rows;
    });

    it('parseNumericCell', () => {
        assert.equal(parseNumericCell('141402'), 141402);
        assert.equal(parseNumericCell('1 874 134,98'), 1874134.98);
        assert.equal(parseNumericCell(''), null);
    });

    it('sum Сальдо Дт начало = 141402', () => {
        const sanitized = sanitizeTableQueryPlan(
            { action: 'aggregate', op: 'sum', column: 'Сальдо Дт начало' },
            headers
        );
        assert.equal(sanitized.ok, true);
        const result = executeTableQueryOnRows(rows, sanitized.plan);
        assert.equal(result.ok, true);
        assert.equal(result.value, 141402);
        assert.equal(result.nonEmpty, 1);
        assert.equal(result.totalRows, 15);
        assert.equal(result.matchedRows, 15);
    });

    it('groupBy Контрагент + sum', () => {
        const sanitized = sanitizeTableQueryPlan(
            {
                action: 'aggregate',
                op: 'sum',
                column: 'Оборот Дт',
                groupBy: 'Контрагент',
            },
            headers
        );
        assert.equal(sanitized.ok, true);
        const result = executeTableQueryOnRows(rows, sanitized.plan);
        assert.ok(result.groups?.length >= 2);
        const aton = result.groups.find((g) => /611/.test(g.key));
        assert.ok(aton);
        assert.ok(aton.value > 0);
    });

    it('sanitize rejects unknown column', () => {
        const sanitized = sanitizeTableQueryPlan(
            { action: 'aggregate', op: 'sum', column: 'Несуществующая' },
            headers
        );
        assert.equal(sanitized.ok, false);
    });

    it('formatQueryResultMessage for sum', () => {
        const msg = formatQueryResultMessage({
            ok: true,
            op: 'sum',
            column: 'Сальдо Дт начало',
            value: 141402,
            formattedValue: '141 402',
            matchedRows: 15,
            totalRows: 15,
            nonEmpty: 1,
        });
        assert.match(msg, /141 402/);
        assert.match(msg, /Сальдо Дт начало/);
    });
});

describe('table_query_llm regex planner', () => {
    it('«а по сальдо Дт начало?» → sum', async () => {
        const parsed = parseOsvFlatSheet(fs.readFileSync(FIXTURE), 'Обработанная ОСВ');
        const planned = await planTableQuery({
            message: 'а по сальдо Дт начало?',
            headers: parsed.headers,
            rows: parsed.rows.slice(0, 5),
            chatHistory: [],
            useLlm: false,
        });
        assert.equal(planned.planner, 'regex');
        assert.equal(planned.plan?.op, 'sum');
        assert.equal(planned.plan?.column, 'Сальдо Дт начало');
    });

    it('parseAggregateIntentRegex count rows', () => {
        const parsed = parseOsvFlatSheet(fs.readFileSync(FIXTURE), 'Обработанная ОСВ');
        const planned = parseAggregateIntentRegex('сколько строк в таблице', parsed.headers);
        assert.equal(planned?.plan?.op, 'count');
    });
});

describe('table_query_clauses compound', () => {
    let headers;
    let rows;
    let samples;

    it('prepare fixture', () => {
        const parsed = parseOsvFlatSheet(fs.readFileSync(FIXTURE), 'Обработанная ОСВ');
        headers = parsed.headers;
        rows = parsed.rows;
        samples = pickColumnSamples(rows, headers, 5);
    });

    it('sanitizeFilterPlan сохраняет кириллическую колонку', () => {
        const plan = sanitizeFilterPlan(
            { filters: [{ column: 'Подразделение', op: 'contains', value: '2' }] },
            headers
        );
        assert.equal(plan.filters.length, 1);
        assert.equal(plan.filters[0].column, 'Подразделение');
    });

    it('«подразделению 2 и Оборот ДТ» → filter + metric', () => {
        const msg = 'а какая сумма по подразделению 2 и Оборот ДТ';
        const clauses = parseAggregateClauses(msg, headers, samples);
        assert.equal(clauses.column, 'Оборот Дт');
        assert.equal(clauses.groupBy, null);
        assert.equal(clauses.filters.length, 1);
        assert.equal(clauses.filters[0].column, 'Подразделение');
        assert.equal(clauses.uncertain, false);

        const planned = parseAggregateIntentRegex(msg, headers, samples);
        assert.equal(planned.planner, 'regex');
        assert.equal(planned.plan?.column, 'Оборот Дт');
        assert.equal(planned.plan?.filters.length, 1);
        assert.equal(planned.plan?.groupBy, null);
    });

    it('filtered sum по подразделению 2 ≠ общая сумма', () => {
        const msg = 'а какая сумма по подразделению 2 и Оборот ДТ';
        const planned = parseAggregateIntentRegex(msg, headers, samples);
        const filtered = executeTableQueryOnRows(rows, planned.plan);
        const all = executeTableQueryOnRows(
            rows,
            sanitizeTableQueryPlan({ action: 'aggregate', op: 'sum', column: 'Оборот Дт' }, headers).plan
        );

        assert.ok(filtered.matchedRows < all.matchedRows);
        assert.notEqual(filtered.value, all.value);
        assert.ok(filtered.value > 0);
        assert.ok(filtered.filterSummary);
        assert.match(filtered.filterSummary, /Подразделение/);
    });

    it('«по каждому контрагенту сумма оборот дт» → groupBy без filter', () => {
        const msg = 'по каждому контрагенту сумма оборот дт';
        const clauses = parseAggregateClauses(msg, headers, samples);
        assert.equal(clauses.groupBy, 'Контрагент');
        assert.equal(clauses.filters.length, 0);
        assert.equal(clauses.column, 'Оборот Дт');

        const planned = parseAggregateIntentRegex(msg, headers, samples);
        assert.equal(planned.plan?.groupBy, 'Контрагент');
        assert.equal(planned.plan?.filters.length, 0);
    });

    it('«подразделению 4 всего оборотов по ДТ» без «и» → eq, не contains', () => {
        const msg = 'а можешь посчитать итого сколько по подразделению 4 всего оборотов по ДТ';
        const clauses = parseAggregateClauses(msg, headers, samples);
        assert.equal(clauses.column, 'Оборот Дт');
        assert.equal(clauses.filters.length, 1);
        assert.equal(clauses.filters[0].op, 'eq');
        assert.ok(
            clauses.filters[0].value === '4' ||
                /подразделение\s*4/i.test(clauses.filters[0].value)
        );
        assert.equal(clauses.uncertain, false);

        const planned = parseAggregateIntentRegex(msg, headers, samples);
        assert.equal(planned?.plan?.column, 'Оборот Дт');
        assert.equal(planned?.plan?.filters[0]?.op, 'eq');
        const result = executeTableQueryOnRows(rows, planned.plan);
        const loose = executeTableQueryOnRows(
            rows,
            sanitizeTableQueryPlan(
                {
                    action: 'aggregate',
                    op: 'sum',
                    column: 'Оборот Дт',
                    filters: [{ column: 'Подразделение', op: 'contains', value: '4' }],
                },
                headers
            ).plan
        );
        if (loose.matchedRows !== result.matchedRows) {
            assert.notEqual(loose.value, result.value);
        }
    });

    it('formatQueryResultMessage показывает условие фильтра', () => {
        const msg = 'а какая сумма по подразделению 2 и Оборот ДТ';
        const planned = parseAggregateIntentRegex(msg, headers, samples);
        const result = executeTableQueryOnRows(rows, planned.plan);
        const text = formatQueryResultMessage(result);
        assert.match(text, /Подразделение/);
        assert.match(text, /из 15 строк/);
    });
});

describe('table_query broker filter regression', () => {
    const BROKER_HEADERS = ['debit_account', 'credit_account', 'amount', 'name'];

    it('debit_account + sum amount', () => {
        const msg = 'сумма amount где debit_account=58.01.4';
        const planned = parseAggregateIntentRegex(msg, BROKER_HEADERS, {});
        assert.equal(planned?.plan?.column, 'amount');
        assert.equal(planned?.plan?.filters.length, 1);
        assert.equal(planned?.plan?.filters[0].column, 'debit_account');
    });
});
