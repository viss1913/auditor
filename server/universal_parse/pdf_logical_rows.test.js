const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeContinuationLines, isContinuationLine } = require('./pdf_logical_rows');

describe('pdf_logical_rows', () => {
    it('mergeContinuationLines: склеивает перенос', () => {
        const physical = [
            {
                index: 0,
                page: 1,
                y: 100,
                text: 'ООО Логистика длинное наименование',
                items: [
                    { text: 'ООО', x0: 40 },
                    { text: 'Логистика', x0: 80 },
                    { text: 'длинное', x0: 160 },
                ],
            },
            {
                index: 1,
                page: 1,
                y: 88,
                text: 'наименование',
                items: [{ text: 'наименование', x0: 42 }],
            },
            {
                index: 2,
                page: 1,
                y: 70,
                text: 'MSK-SPB 100 шт',
                items: [
                    { text: 'MSK-SPB', x0: 40 },
                    { text: '100', x0: 200 },
                    { text: 'шт', x0: 240 },
                ],
            },
        ];
        const logical = mergeContinuationLines(physical);
        assert.equal(logical.length, 2);
        assert.equal(logical[0].continuation, true);
        assert.match(logical[0].text, /наименование/);
    });

    it('isContinuationLine: не склеивает две data-строки', () => {
        const prev = {
            page: 1,
            y: 100,
            text: 'RU000A0JX0J2 100 01.02.2025',
            items: [
                { text: 'RU000A0JX0J2', x0: 40 },
                { text: '100', x0: 180 },
            ],
        };
        const next = {
            page: 1,
            y: 86,
            text: 'RU000A0JX0J3 200 02.02.2025',
            items: [
                { text: 'RU000A0JX0J3', x0: 40 },
                { text: '200', x0: 180 },
            ],
        };
        assert.equal(isContinuationLine(prev, next, { yGapMin: 3, yGapMax: 16, minItemsRatio: 0.45 }), false);
    });
});
