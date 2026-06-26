const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    findSectionStarts,
    extractBrokerPdfSectionTables,
    shouldUseMultiTableBrokerParse,
    resolveSectionsFromMessage,
} = require('./universal_parse/pdf_broker_sections');

describe('pdf_broker_sections', () => {
    const sampleLines = [
        'Отчет о состоянии счетов клиента',
        'Справка о стоимости активов',
        'Валюта    Количество    В рублях',
        'RUR    100    200',
        'USD    50    3000',
        'Обремененные и/или ограниченные в распоряжении ценные бумаги',
        'ЦБ    ISIN    Количество',
        'ЛУКойл    RU0009024277    1000',
        'ГазПром    RU0007661625    2000',
        'Исполненные сделки',
        '№ сделки    Дата    Сумма',
        '1    01.12.25    100',
        '2    02.12.25    200',
    ];

    it('findSectionStarts находит разделы Атон', () => {
        const starts = findSectionStarts(sampleLines);
        assert.ok(starts.length >= 3);
        assert.equal(starts[0].def.id, 'assets');
    });

    it('resolveSectionsFromMessage: обременённые', () => {
        const ids = resolveSectionsFromMessage('разбери обременённые ЦБ');
        assert.deepEqual(ids, ['encumbered']);
    });

    it('multiTable при нескольких разделах без фильтра', async () => {
        const tables = await extractBrokerPdfSectionTables(sampleLines, 'разбери брокерский отчёт');
        assert.ok(tables.length >= 2);
        assert.equal(shouldUseMultiTableBrokerParse(tables, 'разбери брокерский отчёт'), true);
    });

    it('один раздел по запросу в чате', async () => {
        const tables = await extractBrokerPdfSectionTables(
            sampleLines,
            'разбери исполненные сделки'
        );
        assert.equal(tables.length, 1);
        assert.equal(tables[0].id, 'trades');
        assert.equal(shouldUseMultiTableBrokerParse(tables, 'разбери исполненные сделки'), false);
    });
});
