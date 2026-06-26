const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { parseBrokerSheet, parseBrokerFromBuffer } = require('./parse_broker');

function brokerSection12Header() {
    return '1.2. Сделки, обязательства из которых не исполнены';
}

function brokerSection11Header() {
    return '1.1. Сделки, обязательства из которых прекращены';
}

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

    it('parseBrokerFromBuffer: buffer xlsx', async () => {
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
        const rows = await parseBrokerFromBuffer(buf);
        assert.ok(rows.length >= 1);
        assert.match(rows[0].operationType, /продажа/i);
    });

    it('isBrokerSection12Start: альтернативный заголовок', () => {
        const { isBrokerSection12Start } = require('./parse_broker');
        assert.equal(
            isBrokerSection12Start('1.2 Сделки, ожидающие исполнения на отчётную дату'),
            true
        );
        assert.equal(isBrokerSection12Start(brokerSection12Header()), true);
    });

    it('parseBrokerSheet: секция 1.1 прекращённые', () => {
        const data = [
            [brokerSection11Header()],
            [
                '17.01.2025',
                '',
                'Покупка РЕПО',
                'НКО НКЦ ISIN RU000A0JW4Z1',
                100,
                50000,
                'RUB',
                '20.01.2025',
                '21.01.2025',
                50,
            ],
            [brokerSection12Header()],
        ];
        const rows = parseBrokerSheet(data, 'test', { sectionId: '1.1' });
        assert.ok(rows.length >= 1);
        assert.match(rows[0].operationType, /репо/i);
    });

    it('parseBrokerSheet: секция 1.2 не берёт строки из 1.1', () => {
        const data = [
            [brokerSection11Header()],
            [
                '17.01.2025',
                '',
                'Покупка РЕПО',
                'НКО НКЦ ISIN RU000A0JW4Z1',
                100,
                50000,
                'RUB',
                '20.01.2025',
                '21.01.2025',
                50,
            ],
            [brokerSection12Header()],
        ];
        const rows = parseBrokerSheet(data, 'test', { sectionId: '1.2' });
        assert.equal(rows.length, 0);
    });

    it('isBrokerSectionEnd: не режет 1.2 на сумме 11.39 и дате 22.01.2025', () => {
        const { isBrokerSectionEnd, brokerSectionTitleHead } = require('./parse_broker');
        const rowSlice = [
            '22.01.2025 13:15:45',
            '',
            '',
            '',
            '',
            'Покупка',
            '',
            '',
            'MICEX',
            '11.39',
        ].join(' ');
        const rowText = `${rowSlice} RUB 23.01.2025 11.39 rub`;
        assert.equal(isBrokerSectionEnd(rowText, rowSlice), false);
        assert.equal(
            isBrokerSectionEnd(
                '1.3. Сделки, обязательства из которых не исполнены (ранее заключенные)',
                '1.3. Сделки, обязательства из которых не исполнены (ранее заключенные)'
            ),
            true
        );
        assert.match(brokerSectionTitleHead(rowSlice), /^22\.01\.2025/);
    });

    it('parseBrokerSheet: раздел 1.2 не обрывается на строке с 11.39 в сумме', () => {
        const wideRow = (date, amount) => {
            const row = Array.from({ length: 112 }, () => '');
            row[0] = date;
            row[5] = 'Покупка';
            row[24] = 'ПАО Test ISIN RU0009029540';
            row[42] = 100;
            row[55] = amount;
            row[72] = 'RUB';
            row[87] = date;
            return row;
        };
        const data = [
            [brokerSection12Header()],
            ['Дата и время сделки', '', '', '', '', 'Вид сделки'],
            wideRow('21.01.2025', 50000),
            wideRow('22.01.2025 13:15:45', 11.39),
            wideRow('23.01.2025', 12000),
            ['1.3. Сделки, обязательства из которых не исполнены (ранее заключенные)'],
        ];
        const rows = parseBrokerSheet(data, 'test', { sectionId: '1.2' });
        assert.equal(rows.length, 3);
    });

    it('isBrokerSectionGapEnd: пустые строки после сделок — конец раздела 1.2', () => {
        const { isBrokerSectionGapEnd, isBrokerSectionEnd } = require('./parse_broker');
        const data = [
            [brokerSection12Header()],
            ['Дата и время сделки', '', '', '', '', 'Вид сделки'],
            ['22.01.2025', '', 'Покупка', 'ПАО Test ISIN RU0009029540', 100],
            [''],
            [''],
            ['1.3. Сделки, обязательства из которых не исполнены (ранее заключенные)'],
        ];
        assert.equal(isBrokerSectionGapEnd(data, 3, true), true);
        assert.equal(isBrokerSectionGapEnd(data, 3, false), false);
        assert.equal(
            isBrokerSectionEnd(
                '1.4. Сделки, обязательства из которых прекращены (ранее заключенные)',
                '1.4. Сделки, обязательства из которых прекращены (ранее заключенные)'
            ),
            true
        );
    });

    it('parseBrokerSheet: обрыв 1.2 на пропуске перед 1.3', () => {
        const trade = [
            '22.01.2025 18:15:45',
            '',
            '',
            '',
            '',
            'Продажа РЕПО',
            '',
            'MICEX',
            'НКО НКЦ ISIN RU000A0JW4Z1',
            1700000,
        ];
        const data = [
            [brokerSection12Header()],
            ['Дата и время сделки', '', '', '', '', 'Вид сделки'],
            trade,
            [''],
            [''],
            [''],
            ['1.3. Сделки, обязательства из которых не исполнены (ранее заключенные)'],
            ['Дата и время сделки', '', '', '', '', 'Вид сделки'],
            [
                '23.01.2025',
                '',
                'Покупка',
                'Другой эмитент ISIN RU000A0JX0J2',
                50,
            ],
        ];
        const rows = parseBrokerSheet(data, 'test', { sectionId: '1.2' });
        assert.equal(rows.length, 1);
        assert.match(rows[0].operationType, /продажа/i);
    });

    it('findBrokerHeaderMap: % репо и номер сделки на бирже', () => {
        const { findBrokerHeaderMap } = require('./parse_broker');
        const headerRows = [
            [],
            [],
            [],
            Array.from({ length: 110 }, () => ''),
        ];
        headerRows[3][108] = '% РЕПО';
        headerRows[3][109] = 'Номер сделки на бирже';
        headerRows[3][96] = 'брокерская';
        const map = findBrokerHeaderMap(headerRows, 0);
        assert.equal(map.repo_percent, 108);
        assert.equal(map.exchange_trade_number, 109);
        assert.equal(map.broker_fee, 96);
    });

    it('parseBrokerSheet: repo_percent и exchange_trade_number по шапке', () => {
        const dataRow = Array.from({ length: 112 }, () => '');
        dataRow[0] = '10.02.2025';
        dataRow[5] = 'Покупка РЕПО';
        dataRow[24] = 'ОФЗ ISIN RU000A0JX0J2';
        dataRow[42] = 6300000;
        dataRow[55] = 6300000;
        dataRow[72] = 'RUB';
        dataRow[87] = '10.02.2025';
        dataRow[96] = 86.31;
        dataRow[108] = 20.51;
        dataRow[109] = '12253728034';
        dataRow[111] = '1F018/1F0001';

        const data = [
            [brokerSection11Header()],
            ['Дата и время сделки', '', '', '', '', 'Вид сделки'],
            ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Ценная бумага'],
            [
                ...Array.from({ length: 96 }, () => ''),
                'брокерская',
                ...Array.from({ length: 11 }, () => ''),
                '% РЕПО',
                'Номер сделки на бирже',
                '',
                'Портфель/Субсчет',
            ],
            dataRow,
            [brokerSection12Header()],
        ];
        const rows = parseBrokerSheet(data, 'test', { sectionId: '1.1' });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].repo_percent, 20.51);
        assert.equal(rows[0].exchange_trade_number, '12253728034');
        assert.equal(rows[0].fee, 86.31);
        assert.equal(rows[0].quantity, 6300000);
    });
});
