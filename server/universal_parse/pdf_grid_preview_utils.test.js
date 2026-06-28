const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    suggestDataStartRow,
    pageDataStartToGridDataStart,
    clusteredRowsForPreview,
    inferColumnCentersFromPageRows,
} = require('./pdf_grid_preview_utils');

test('suggestDataStartRow picks first data row after ISIN header', () => {
    const rows = [
        { text: 'Квантум' },
        { text: 'INVESTMENT ACCOUNT STATEMENT — клиент KV-77102' },
        { text: 'брокерский отчёт' },
        { text: '№ ISIN Тикер Кол-во Цена Сумма' },
        { text: '1 RU0009029540 SBER 100 250.5 25050' },
        { text: '2 RU000A0JX0J2 GAZP 50 180 9000' },
    ];
    assert.equal(suggestDataStartRow(rows), 4);
});

test('pageDataStartToGridDataStart converts page index to region index', () => {
    assert.equal(pageDataStartToGridDataStart(4, 0), 3);
    assert.equal(pageDataStartToGridDataStart(0, 0), 0);
});

test('suggestDataStartRow picks first data row after UPD header', () => {
    const rows = [
        { text: 'УПД' },
        { text: 'Счет-фактура No 884/У от 12.03.2025' },
        { text: 'Наименование товара Кол-во Цена Сумма НДС' },
        { text: 'Светодиодная лента 24V 120 м 85,00 10 200,00 20%' },
    ];
    assert.equal(suggestDataStartRow(rows), 3);
});

test('inferColumnCentersFromPageRows reads header item positions', () => {
    const rows = [
        { text: 'header' },
        {
            text: 'Наименование товара Кол-во Цена',
            items: [{ x: 40 }, { x: 200 }, { x: 290 }],
        },
        { text: 'Товар 1 10 шт 100,00' },
    ];
    assert.deepEqual(inferColumnCentersFromPageRows(rows, 2), [40, 200, 290]);
});

test('clusteredRowsForPreview marks header candidates', () => {
    const rows = [{ text: 'header' }, { text: '1 2 3 4' }];
    const out = clusteredRowsForPreview(rows, 595, 842);
    assert.equal(out[0].isHeaderCandidate, true);
    assert.equal(out[1].isHeaderCandidate, false);
});
