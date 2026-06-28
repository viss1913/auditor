const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    computeQualityScore,
    scenarioAutoApplyDecision,
    shouldSuspendScenario,
} = require('./pdf_scenario_quality');

describe('pdf_scenario_quality', () => {
    it('computeQualityScore: взвешенная сумма', () => {
        const q = computeQualityScore({
            signals: { headerSample: ['ISIN', 'Qty'], columnCount: 3 },
            scenarioRow: {
                ruleJson: {
                    columns: [{ label: 'ISIN' }, { label: 'Qty' }, { label: 'Date' }],
                    stats: { success_count: 9, failure_count: 1 },
                },
            },
            gridTable: {
                headers: ['ISIN', 'Qty', 'Date'],
                rows: [
                    { ISIN: 'RU000A0JX0J2', Qty: '100', Date: '01.02.2025' },
                    { ISIN: 'RU000A0JX0J3', Qty: '200', Date: '02.02.2025' },
                ],
            },
        });
        assert.ok(q.quality_score >= 0.5 && q.quality_score <= 1);
    });

    it('scenarioAutoApplyDecision: draft blocked', () => {
        const d = scenarioAutoApplyDecision(0.95, 'draft');
        assert.equal(d.apply, false);
        assert.match(d.reason, /draft/);
    });

    it('scenarioAutoApplyDecision: approved high score', () => {
        const d = scenarioAutoApplyDecision(0.92, 'approved');
        assert.equal(d.apply, true);
        assert.equal(d.mode, 'confident');
    });

    it('shouldSuspendScenario: 3 failures', () => {
        assert.equal(shouldSuspendScenario(3), true);
        assert.equal(shouldSuspendScenario(2), false);
    });
});
