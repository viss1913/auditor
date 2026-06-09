const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { inferColumnsFromTargetHeaders, inferMeasureFromTargetHeader } = require('./target_rule_infer');

describe('target_rule_infer', () => {
    it('мапит заголовки этalona как на скрине', () => {
        const headers = [
            'год',
            'тип',
            '2024 - СТОИМОСТЬ',
            '2024 - АМОРТИЗАЦИЯ (ИЗНОС)',
            '2024 - ОСТАТОЧНАЯ СТОИМОСТЬ',
            '2024 - УВЕЛИЧЕНИЕ СТОИМОСТИ',
            '2024 - НАЧИСЛЕНИЕ АМОРТИЗАЦИИ (ИЗНОСА)',
            '2024 - УМЕНЬШЕНИЕ СТОИМОСТИ',
        ];
        const cols = inferColumnsFromTargetHeaders(headers);
        assert.equal(cols.find((c) => c.target === 'тип')?.source.field, 'asset_name');
        assert.equal(
            cols.find((c) => /ОСТАТОЧНАЯ/i.test(c.target))?.source.measure,
            'residual_close'
        );
        assert.equal(cols.find((c) => /СТОИМОСТЬ$/i.test(c.target))?.source.measure, 'cost_close');
        assert.equal(
            cols.find((c) => /НАЧИСЛЕНИЕ/i.test(c.target))?.source.measure,
            'amort_charge'
        );
    });

    it('остаточная без «конец» → residual_close', () => {
        assert.equal(inferMeasureFromTargetHeader('2024 - ОСТАТОЧНАЯ СТОИМОСТЬ'), 'residual_close');
    });
});
