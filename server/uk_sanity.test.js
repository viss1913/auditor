const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { checkUkParseSanity } = require('./uk_sanity');

describe('uk_sanity', () => {
    it('ловит quantity как сальдо', () => {
        const rows = [
            { quantity: 17_305_836, amount: 1083.5, credit_account: '76.07.2' },
            { quantity: 17_305_836, amount: 61, credit_account: '91.01.10' },
        ];
        const out = checkUkParseSanity(rows, {
            quantity_column: 8,
            has_credit_91: true,
            quantity_options: [
                { index: 7, letter: 'H' },
                { index: 8, letter: 'I' },
            ],
        });
        assert.ok(out.issues.includes('quantity_like_balance'));
        assert.equal(out.suggestQuantityColumn, 7);
    });

    it('ok для нормальных штук', () => {
        const rows = [
            { quantity: 10, amount: 1083.5, credit_account: '76.07.2' },
            { quantity: 0, amount: 61, credit_account: '91.01.10' },
        ];
        const out = checkUkParseSanity(rows, { has_credit_91: true });
        assert.equal(out.ok, true);
    });
});
