const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    probeNeedsFlatParseRefinement,
    previewFailsFlatSanity,
    cellLooksLikeAccount,
} = require('./flat_parse_sanity');

describe('flat_parse_sanity', () => {
    it('probeNeedsFlatParseRefinement: amount === credit', () => {
        assert.equal(
            probeNeedsFlatParseRefinement({
                uk_probe: { amount_column: 9, credit_account_column: 9, document_column: 1, analytics_column: 3 },
            }),
            true
        );
    });

    it('probeNeedsFlatParseRefinement: analytics === document', () => {
        assert.equal(
            probeNeedsFlatParseRefinement({
                uk_probe: { amount_column: 7, credit_account_column: 9, document_column: 1, analytics_column: 1 },
                merged_ranges: [],
            }),
            true
        );
    });

    it('probeNeedsFlatParseRefinement: ok probe', () => {
        assert.equal(
            probeNeedsFlatParseRefinement({
                uk_probe: { amount_column: 7, credit_account_column: 9, document_column: 1, analytics_column: 3 },
            }),
            false
        );
    });

    it('cellLooksLikeAccount', () => {
        assert.equal(cellLooksLikeAccount('76.07.2'), true);
        assert.equal(cellLooksLikeAccount('1083.5'), false);
    });

    it('previewFailsFlatSanity: amount as account', () => {
        assert.equal(
            previewFailsFlatSanity(
                'uk_card',
                { rows: [{ amount: 76.07, quantity: 10, name: 'Мечел', credit_account: '76.07.2' }] },
                {}
            ),
            true
        );
    });

    it('previewFailsFlatSanity: name is deal text', () => {
        assert.equal(
            previewFailsFlatSanity(
                'uk_card',
                {
                    rows: [
                        {
                            amount: 1083,
                            quantity: 10,
                            name: 'Сделка с ц/б НКР083939',
                            credit_account: '76.07.2',
                        },
                    ],
                },
                {}
            ),
            true
        );
    });

    it('previewFailsFlatSanity: os triplicated year metrics', () => {
        assert.equal(
            previewFailsFlatSanity(
                'os_01_hierarchy',
                {
                    headers: [
                        'Группа',
                        '2022 - начало',
                        '2022 - амортизация',
                        '2022 - конец',
                        '2022 - начало',
                        '2022 - амортизация',
                        '2022 - конец',
                    ],
                    rows: [{ Группа: 'Здания', '2022 - начало': 1 }],
                },
                {}
            ),
            true
        );
    });
});
