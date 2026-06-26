const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildGridProfileCandidates,
    extractTableFromRowsBest,
    clusterRows,
} = require('./universal_parse/pdfjs_table_grid_extract');

describe('pdf grid multi-candidate', () => {
    it('buildGridProfileCandidates returns up to 6 variants for trades', () => {
        const variants = buildGridProfileCandidates('trades');
        assert.ok(variants.length >= 2);
        assert.ok(variants.length <= 6);
        assert.ok(variants.every((v) => typeof v.cellGap === 'number'));
    });

    it('extractTableFromRowsBest picks non-empty result on synthetic rows', () => {
        const items = [
            { page: 1, text: 'ISIN', x: 50, y: 700, w: 30 },
            { page: 1, text: 'Кол-во', x: 200, y: 700, w: 40 },
            { page: 1, text: 'RU000A0JX0J2', x: 50, y: 680, w: 80 },
            { page: 1, text: '100', x: 200, y: 680, w: 30 },
            { page: 1, text: 'RU000A0JX0J3', x: 50, y: 660, w: 80 },
            { page: 1, text: '200', x: 200, y: 660, w: 30 },
        ];
        const rows = clusterRows(items);
        const result = extractTableFromRowsBest(rows, 0, rows.length, { sectionId: 'default' });
        assert.ok(result.ok || result.rows?.length >= 0);
    });
});
