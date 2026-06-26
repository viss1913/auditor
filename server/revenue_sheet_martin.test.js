const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    isRevenueSheetContext,
    parseRevenuePeriodBlock,
    parseRevenueOsvTurnoverBlock,
    parseRevenueSheet,
    isRevenueAccountLabel,
} = require('./revenue_sheet_martin');

function sampleRevenueData() {
    return [
        ['Выручка по деятельности', '', '', '', '', '', ''],
        ['ООО Кэселвский', '', '', '', '', '', ''],
        ['', 'На начало периода', '', 'За период', '', 'На конец периода', ''],
        ['', 'Сальдо Дт', 'Сальдо Кт', 'Оборот Дт', 'Оборот Кт', 'Сальдо Дт', 'Сальдо Кт'],
        ['90.01.1, Выручка по деятельности с основной системой налогообложения', 100, 0, 500, 500, 600, 0],
        ['90.02.1, Себестоимость продаж', 50, 0, 200, 200, 250, 0],
    ];
}

describe('revenue_sheet_martin', () => {
    it('isRevenueAccountLabel: 90.01 + выручка', () => {
        assert.equal(
            isRevenueAccountLabel('90.01.1, Выручка по деятельности с основной системой налогообложения'),
            true
        );
        assert.equal(isRevenueAccountLabel('80-000001 Склад инв. №12345'), false);
    });

    it('isRevenueSheetContext: выручка + 90 + период', () => {
        const data = sampleRevenueData();
        assert.equal(isRevenueSheetContext('Выручка.xlsx', 'РД_АП', data), true);
    });

    it('isRevenueSheetContext: структура 90 без имени файла', () => {
        const data = sampleRevenueData();
        assert.equal(isRevenueSheetContext('report.xlsx', 'Лист1', data), true);
    });

    it('parseRevenuePeriodBlock: плоская таблица по счетам 90', () => {
        const parsed = parseRevenuePeriodBlock(sampleRevenueData());
        assert.ok(parsed);
        assert.equal(parsed.rows.length, 2);
        assert.ok(parsed.headers.includes('Счёт'));
        assert.ok(parsed.headers.some((h) => /Оборот Дт/i.test(h)));
        assert.equal(parsed.rows[0]['Счёт'], '90.01.1, Выручка по деятельности с основной системой налогообложения');
        assert.equal(parsed.rows[0]['Юрлицо'], 'ООО Кэселвский');
    });

    it('parseRevenueOsvTurnoverBlock: ОСВ 90.01 с БУ/Кол и номенклатурой', () => {
        const data = [
            ['ООО "СКАЙФУД"', '', '', ''],
            ['Оборотно-сальдовая ведомость по счету 90.01 за 2024-2025', '', '', ''],
            ['Счет, Наименование счета', 'Показатели', 'Дебет', 'Кредит'],
            ['Номенклатурные группы', '', 'Дебет', 'Кредит'],
            ['Период', '', 'Дебет', 'Кредит'],
            ['90.01.1, Выручка', 'БУ', 100, 100],
            ['', 'Кол.', 10, 10],
            ['Готовая продукция', 'БУ', '', 80],
            ['', 'Кол.', '', 8],
            ['Обороты за 2024', 'БУ', '', 50],
            ['', 'Кол.', '', 5],
            ['Товары', 'БУ', '', 20],
            ['', 'Кол.', '', 2],
            ['Обороты за 2024', 'БУ', '', 15],
            ['', 'Кол.', '', 1.5],
            ['Итого', 'БУ', 100, 100],
        ];
        const parsed = parseRevenueOsvTurnoverBlock(data);
        assert.ok(parsed);
        assert.ok(!parsed.headers.includes('Показатель'));
        assert.ok(parsed.headers.includes('Дебет БУ'));
        assert.ok(parsed.headers.includes('Кредит Кол.'));

        const account = parsed.rows.find((r) => r.Уровень === 'счёт');
        assert.ok(account);
        assert.equal(account['Дебет БУ'], 100);
        assert.equal(account['Кредит Кол.'], 10);

        const group = parsed.rows.find((r) => r['Номенклатурная группа'] === 'Готовая продукция' && r.Уровень === 'группа');
        assert.ok(group);
        assert.equal(group['Кредит БУ'], 80);
        assert.equal(group['Кредит Кол.'], 8);

        const periodDetail = parsed.rows.find(
            (r) =>
                r['Номенклатурная группа'] === 'Готовая продукция' &&
                r.Период === 'Обороты за 2024'
        );
        assert.ok(periodDetail);
        assert.equal(periodDetail['Кредит БУ'], 50);
        assert.equal(periodDetail['Кредит Кол.'], 5);
        assert.equal(periodDetail.Уровень, 'период');

        const goodsPeriod = parsed.rows.find(
            (r) => r['Номенклатурная группа'] === 'Товары' && r.Период === 'Обороты за 2024'
        );
        assert.ok(goodsPeriod);
        assert.equal(goodsPeriod['Кредит Кол.'], 1.5);
    });

    it('parseRevenueOsvTurnoverBlock: сводка периода без группы ≠ детализация по группам', () => {
        const data = [
            ['ООО "СКАЙФУД"', '', '', ''],
            ['Оборотно-сальдовая ведомость по счету 90.01', '', '', ''],
            ['Счет, Наименование счета', 'Показатели', 'Дебет', 'Кредит'],
            ['Период', '', 'Дебет', 'Кредит'],
            ['90.01.1, Выручка', 'БУ', 100, 100],
            ['', 'Кол.', 10, 10],
            ['Обороты за 2024', 'БУ', '', 287643028.64],
            ['', 'Кол.', '', 58861478.756],
            ['Готовая продукция', 'БУ', '', 285543159.03],
            ['', 'Кол.', '', 55144287],
            ['Обороты за 2024', 'БУ', '', 285543159.03],
            ['', 'Кол.', '', 55144287],
            ['Товары', 'БУ', '', 10065343.87],
            ['', 'Кол.', '', 163890],
            ['Обороты за 2024', 'БУ', '', 10065343.87],
            ['', 'Кол.', '', 163890],
            ['Итого', 'БУ', 100, 100],
        ];
        const parsed = parseRevenueOsvTurnoverBlock(data);
        assert.ok(parsed);

        const rollup = parsed.rows.find((r) => r.Период === 'Обороты за 2024' && r.Уровень === 'сводка периода');
        assert.ok(rollup);
        assert.equal(rollup['Кредит БУ'], 287643028.64);
        assert.equal(rollup['Кредит Кол.'], 58861478.756);

        const detail = parsed.rows.find(
            (r) =>
                r['Номенклатурная группа'] === 'Готовая продукция' &&
                r.Период === 'Обороты за 2024'
        );
        assert.ok(detail);
        assert.equal(detail['Кредит БУ'], 285543159.03);
        assert.equal(detail['Кредит Кол.'], 55144287);
        assert.notEqual(rollup['Кредит Кол.'], detail['Кредит Кол.']);
    });

    it('parseRevenueOsvTurnoverBlock: 1С дублирует подпись на строках БУ и Кол.', () => {
        const data = [
            ['ООО "СКАЙФУД"', 'Показатели', 'Дебет', 'Кредит'],
            ['Оборотно-сальдовая ведомость по счету 90.01', '', '', ''],
            ['Счет, Наименование счета', 'Показатели', 'Дебет', 'Кредит'],
            ['Период', 'Показатели', 'Дебет', 'Кредит'],
            ['90.01.1, Выручка', 'БУ', 100, 100],
            ['90.01.1, Выручка', 'Кол.', 10, 10],
            ['Обороты за 2024', 'БУ', 2876430328.64, ''],
            ['Обороты за 2024', 'Кол.', 58861478.756, ''],
            ['Готовая продукция', 'БУ', '', 6463571262.98],
            ['Готовая продукция', 'Кол.', '', 116604282],
            ['Обороты за 2024', 'БУ', '', 2855423159.03],
            ['Обороты за 2024', 'Кол.', '', 55144287],
            ['Итого', 'БУ', 100, 100],
        ];
        const parsed = parseRevenueOsvTurnoverBlock(data);
        assert.ok(parsed);
        assert.equal(
            parsed.rows.filter((r) => r.Период === 'Обороты за 2024' && r.Уровень === 'сводка периода').length,
            1
        );
        const rollup = parsed.rows.find((r) => r.Период === 'Обороты за 2024' && r.Уровень === 'сводка периода');
        assert.equal(rollup['Дебет БУ'], 2876430328.64);
        assert.equal(rollup['Дебет Кол.'], 58861478.756);
        const gp = parsed.rows.find(
            (r) => r['Номенклатурная группа'] === 'Готовая продукция' && r.Период === 'Обороты за 2024'
        );
        assert.equal(gp['Кредит БУ'], 2855423159.03);
        assert.equal(gp['Кредит Кол.'], 55144287);
    });

    it('parseRevenueSheet: docs/Павел/Выручка.xlsx РД_АП', () => {
        const fixture = path.join(__dirname, '..', 'docs', 'Павел', 'Выручка.xlsx');
        if (!fs.existsSync(fixture)) return;
        const buf = fs.readFileSync(fixture);
        const parsed = parseRevenueSheet(buf, 'РД_АП', 'Выручка.xlsx');
        assert.ok(parsed?.rows?.length > 10, `rows=${parsed?.rows?.length}`);
        assert.ok(parsed.headers.includes('Дебет БУ'));
        assert.ok(parsed.rows.some((r) => r['Номенклатурная группа'] === 'Готовая продукция'));
    });
});
