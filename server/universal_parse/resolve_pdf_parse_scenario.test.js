const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hasTabularGridLayout } = require('./resolve_pdf_parse_scenario');

describe('resolve_pdf_parse_scenario helpers', () => {
    it('hasTabularGridLayout: true for grid with columns', () => {
        assert.equal(
            hasTabularGridLayout({ columnCount: 6, gridConfidence: 0.7, columnCentersNorm: [0.1, 0.5] }),
            true
        );
    });

    it('hasTabularGridLayout: false for empty grid', () => {
        assert.equal(hasTabularGridLayout({ columnCount: 0, gridConfidence: 0 }), false);
    });
});
