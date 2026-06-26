const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    extractSectionsFromGrid,
    parseRuNumber,
    isReasonableGridTable,
    mergeMultilineDataRows,
    mergeTradesClusterRows,
    repairAtonTradesRows,
    isTradeDataRowAnchor,
} = require('./universal_parse/pdfjs_table_grid_extract');
const { SECTION_DEFS } = require('./universal_parse/pdf_broker_sections');

const OCTOBER = path.join(__dirname, 'fixtures', 'broker_aton', 'client_24951000_01.10.2025_to_31.10.2025.pdf');

describe('pdfjs_table_grid_extract', () => {
    it('parseRuNumber: русский формат → number', () => {
        assert.equal(parseRuNumber('1 479 171,19'), 1479171.19);
        assert.equal(parseRuNumber('текст'), 'текст');
    });

    it('isReasonableGridTable: отсекает склеенные простыни заголовков', () => {
        assert.equal(
            isReasonableGridTable({
                ok: true,
                rows: [{ a: 1 }],
                headers: ['x'.repeat(200)],
            }),
            false
        );
    });

    it('mergeMultilineDataRows: склеивает continuation-строки trades', () => {
        const pairs = [
            {
                srcText: 'ПАО Московская mcxs1434048333012, Покупка,',
                cells: ['', 'ПАО Московская', 'mcxs1434048333012,', 'Покупка,'],
            },
            {
                srcText: '1 Биржа, Фондовый 30.09.25, 12:45:56 Часть 2',
                cells: ['1', 'Биржа, Фондовый', '30.09.25, 12:45:56', 'Часть 2'],
            },
            {
                srcText: 'рынок 33498-E',
                cells: ['', 'рынок', '', '', '33498-E'],
            },
        ];
        const merged = mergeMultilineDataRows(pairs, 'trades');
        assert.equal(merged.length, 1);
        assert.equal(merged[0][0], '1');
        assert.match(merged[0][1], /ПАО Московская.*Биржа, Фондовый.*рынок/);
        assert.match(merged[0][2], /mcxs1434048333012.*30\.09\.25/);
        assert.equal(merged[0][3], 'Покупка, Часть 2');
        assert.equal(isTradeDataRowAnchor(pairs[0].srcText), true);
        assert.equal(isTradeDataRowAnchor(pairs[1].srcText), false);
    });

    it('mergeTradesClusterRows: склеивает Y-линии до разбиения по колонкам', () => {
        const rows = [
            {
                text: 'Московская mcxs143043507 Продажа, ИНТЕР РАО',
                items: [{ text: 'Московская' }, { text: 'mcxs143043507' }],
            },
            {
                text: '1 Биржа, 8822, 26.09.25, Часть 2 ЕЭС4(C)/RU000A0JP',
                items: [{ text: '1' }, { text: 'Биржа,' }],
            },
        ];
        const merged = mergeTradesClusterRows(rows);
        assert.equal(merged.length, 1);
        assert.match(merged[0].text, /mcxs143043507/);
        assert.match(merged[0].text, /Часть 2/);
        assert.equal(merged[0].items.length, 4);
    });

    it('repairAtonTradesRows: склеивает уже разбитые объекты строк', () => {
        const headers = ['№ п/п', 'ПАО', 'col_3', 'сделки (покупка/ продажа), часть (1-ая, 2-ая)'];
        const rows = [
            {
                '№ п/п': '',
                ПАО: 'Московская',
                col_3: 'mcxs143043507',
                'сделки (покупка/ продажа), часть (1-ая, 2-ая)': 'Продажа,',
            },
            {
                '№ п/п': 1,
                ПАО: 'Биржа,',
                col_3: '8822, 26.09.25,',
                'сделки (покупка/ продажа), часть (1-ая, 2-ая)': 'Часть 2',
            },
        ];
        const repaired = repairAtonTradesRows(rows, headers);
        assert.equal(repaired.length, 1);
        assert.equal(repaired[0]['№ п/п'], 1);
        assert.match(repaired[0].ПАО, /Московская.*Биржа/);
        assert.match(repaired[0].col_3, /mcxs143043507/);
        assert.equal(repaired[0]['сделки (покупка/ продажа), часть (1-ая, 2-ая)'], 'Продажа, Часть 2');
    });

    it('ATON октябрь: assets + reserved + trades', async () => {
        assert.ok(fs.existsSync(OCTOBER));
        const buf = fs.readFileSync(OCTOBER);
        const sections = await extractSectionsFromGrid(buf, SECTION_DEFS);
        const byId = Object.fromEntries(sections.map((s) => [s.id, s]));

        assert.ok(byId.assets?.rows.length >= 3);
        assert.ok(byId.reserved?.rows.length >= 4);
        assert.ok(byId.trades?.rows.length >= 140);
        assert.ok(byId.trades?.rows.length <= 165, `trades rows: ${byId.trades?.rows.length}`);
        assert.ok(byId.trades?.headers.length >= 21, `trades cols: ${byId.trades?.headers.length}`);

        const dealKey =
            byId.trades.headers.find((h) => /сделк.*дата/i.test(String(h))) ||
            byId.trades.headers.find((h) => /col_3/i.test(String(h)));
        const first = byId.trades.rows[0];
        const dealVal = String(first[dealKey] || '');
        assert.match(dealVal, /mcxs\d+/i);
        assert.match(dealVal, /\d{2}\.\d{2}\.\d{2}/);

        const firstAsset = byId.assets.rows[0];
        const numVals = Object.values(firstAsset).filter((v) => typeof v === 'number');
        assert.ok(numVals.length >= 2, 'числовые колонки в assets');
    });
});
