const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { parseBrokerSheet, parseBrokerFromBuffer } = require('./parse_broker');

function brokerSectionHeader() {
    return '1.2. Сделки, не исполнены на отчетную дату';
}

function makeBrokerWorkbookRows(dataRows) {
    const rows = [
        [brokerSectionHeader()],
        ...dataRows,
        ['1.3. Прочее'],
    ];
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('parse_broker', () => {
    it('parseBrokerSheet: строка покупки в разделе 1.2', () => {
        const data = [
            [brokerSectionHeader()],
            [
                '15.01.2024',
                '',
                'Покупка',
                'ПАО Test ISIN RU0009029540',
                100,
                50000,
                'RUB',
                '20.01.2024',
                '21.01.2024',
                50,
            ],
        ];
        const rows = parseBrokerSheet(data, 'test');
        assert.ok(rows.length >= 1);
        assert.equal(rows[0].operationType.toLowerCase(), 'покупка');
        assert.equal(rows[0].isin, 'RU0009029540');
        assert.equal(rows[0].currency, 'RUB');
    });

    it('parseBrokerFromBuffer: buffer xlsx', () => {
        const buf = makeBrokerWorkbookRows([
            [
                '15.01.2024',
                '',
                'Продажа',
                'Эмитент ISIN RU000A0JX0J2',
                10,
                9000,
                'RUB',
                '16.01.2024',
                '17.01.2024',
                5,
            ],
        ]);
        const rows = parseBrokerFromBuffer(buf);
        assert.ok(rows.length >= 1);
        assert.match(rows[0].operationType, /продажа/i);
    });
});
