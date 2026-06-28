const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeGridDiff } = require('./pdf_grid_diff');

describe('pdf_grid_diff', () => {
    it('computeGridDiff: видит расхождение колонок', () => {
        const diff = computeGridDiff(
            { headers: ['A', 'B'], rows: [{ A: '1', B: '2' }, { A: '3', B: '4' }] },
            { headers: ['A', 'B', 'C', 'D'], rows: [{ A: '1', B: '2', C: 'x', D: 'y' }] },
            { scenarioId: 1, scenarioName: 'test' }
        );
        assert.equal(diff.columnCountDelta, -2);
        assert.equal(diff.hasDiff, true);
        assert.equal(diff.recommendedSource, 'scenario');
    });
});
