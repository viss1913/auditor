const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    parseKsSheet,
    isKsSheetName,
    KS_CARD_HEADERS,
    KS_COMPOSITE_RAW_HEADERS,
    expandKsCompositeRow,
    splitKsBlock2,
    splitKsBlock3,
} = require('./ks_sheet_martin');

const FIXTURE = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('ks_sheet_martin', () => {
    it('isKsSheetName', () => {
        assert.equal(isKsSheetName('Исходная КС'), true);
        assert.equal(isKsSheetName('Обработанная ОСВ'), false);
    });

    it('splitKsBlock2: выручка без подписей — контрагент и счёт-фактура', () => {
        const fields = splitKsBlock2([
            'ПСК Беспятово',
            'АГРОАСПЕКТ ООО',
            'Сч.ф. № 69 от 04.01.2025',
            'Реализация (акт, накладная, УПД) 0000-000069 от 04.01.2025 0:00:00',
        ]);
        assert.equal(fields.subdivision_dt, 'ПСК Беспятово');
        assert.equal(fields.counterparty, 'АГРОАСПЕКТ ООО');
        assert.match(fields.contract, /Сч\.ф/);
    });

    it('splitKsBlock3: выручка — номенклатура отдельно от подразделения', () => {
        const fields = splitKsBlock3([
            'ПСК Беспятово',
            'Готовая продукция',
            '10%',
            'Мука 10 шт х 1 кг "Селяночка"',
        ]);
        assert.equal(fields.subdivision_kt, 'ПСК Беспятово');
        assert.equal(fields.operation_name, 'Готовая продукция');
        assert.equal(fields.rate, '10%');
        assert.match(fields.product_name, /Мука/);
        assert.ok(!fields.operation_name.includes('ПСК'));
    });

    it('splitKsBlock3: отдельные поля без склейки', () => {
        const fields = splitKsBlock3([
            'Подразделение 1',
            'Услуги доработки металла',
            '20%',
            'Наименование металла',
        ]);
        assert.equal(fields.subdivision_kt, 'Подразделение 1');
        assert.equal(fields.operation_name, 'Услуги доработки металла');
        assert.equal(fields.rate, '20%');
        assert.equal(fields.product_name, 'Наименование металла');
    });

    it('parseKsSheet: оба листа КС из fixture 76 — единая схема колонок', () => {
        const buf = fs.readFileSync(FIXTURE);
        const flat = parseKsSheet(buf, 'Обработанная КС');
        assert.ok(flat);
        assert.equal(flat.scenarioId, 'ks_card_flat');
        assert.deepEqual(flat.headers, KS_CARD_HEADERS);
        assert.ok(flat.rows.length >= 5);
        assert.equal(flat.rows[0].debit_account, '62.01');
        assert.equal(flat.rows[0].credit_account, '90.01.1');
        assert.equal(flat.rows[0].debit_amount, '');
        assert.equal(String(flat.rows[0].credit_amount), '3263.05');
        assert.equal(flat.rows[0].subdivision_kt, 'Подразделение 1');
        assert.equal(flat.rows[0].operation_name, 'Услуги доработки металла');
        assert.equal(flat.rows[0].rate, '20%');
        assert.match(flat.rows[0].product_name, /металла/i);
        assert.equal(flat.rows[0].product, undefined);

        const src = parseKsSheet(buf, 'Исходная КС');
        assert.ok(src);
        assert.equal(src.scenarioId, 'ks_card_composite_raw');
        assert.deepEqual(src.headers, KS_COMPOSITE_RAW_HEADERS);
        assert.ok(src.rows.length >= 5);
        assert.match(src.rows[0]['Аналитика Дт'], /Контрагент 1/);
        assert.equal(src.rows[0]['Счёт Кт'], '90.01.1');
        assert.equal(String(src.rows[0]['Сумма Кт']), '3263.05');

        const expanded = expandKsCompositeRow(src.rows[0]);
        assert.equal(expanded.counterparty, 'Контрагент 1');
        assert.equal(expanded.subdivision_kt, 'Подразделение 1');
        assert.equal(expanded.operation_name, 'Услуги доработки металла');
        assert.equal(expanded.rate, '20%');
        assert.match(expanded.product_name, /металла/i);
    });

    it('parseKsSheet: Лист1 из docs/Павел/Выручка.xlsx — сырой вид', () => {
        const fixture = path.join(__dirname, '..', 'docs', 'Павел', 'Выручка.xlsx');
        if (!fs.existsSync(fixture)) return;
        const buf = fs.readFileSync(fixture);
        const parsed = parseKsSheet(buf, 'Лист1');
        assert.ok(parsed?.rows?.length >= 4);
        assert.deepEqual(parsed.headers, KS_COMPOSITE_RAW_HEADERS);
        assert.equal(parsed.rows[0]['Счёт Кт'], '90.01.1');
        assert.equal(String(parsed.rows[0]['Счёт Дт']), '62.01');
        assert.match(parsed.rows[0]['Аналитика Дт'], /АГРОАСПЕКТ ООО/);
        assert.match(parsed.rows[0]['Аналитика Кт'], /Готовая продукция/);
        assert.equal(String(parsed.rows[0]['кол-во']), '3850');

        const expanded = expandKsCompositeRow(parsed.rows[0]);
        assert.equal(expanded.counterparty, 'АГРОАСПЕКТ ООО');
        assert.equal(expanded.operation_name, 'Готовая продукция');
    });

    it('parseKsSheet: journal card_76_07_6 — текущее сальдо в двух колонках', () => {
        const fixture = path.join(__dirname, 'fixtures', 'tricky', 'journal', 'card_76_07_6.xlsx');
        if (!fs.existsSync(fixture)) return;
        const buf = fs.readFileSync(fixture);
        const parsed = parseKsSheet(buf, 'Лист1');
        assert.ok(parsed?.rows?.length >= 900);
        assert.ok(parsed.headers.includes('Текущее сальдо'));
        assert.ok(parsed.headers.includes('Сальдо Д/К'));
        assert.equal(parsed.rows[0].Период, 'Сальдо на начало');
        assert.equal(parsed.rows[0]['Сальдо Д/К'], 'Д');
        assert.equal(String(parsed.rows[0]['Текущее сальдо']), '119728885.25');
        const tx = parsed.rows.find((r) => r['Счёт Дт'] === '76.07.6.1');
        assert.ok(tx);
        assert.equal(tx['Сальдо Д/К'], 'Д');
        assert.equal(String(tx['Текущее сальдо']), '117019539.25');
    });
});
