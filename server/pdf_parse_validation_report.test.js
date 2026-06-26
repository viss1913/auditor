const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildPdfParseValidationReport, headerOverlap } = require('./pdf_parse_validation_report');

describe('pdf_parse_validation_report', () => {
    it('pass на нормальном preview', () => {
        const report = buildPdfParseValidationReport({
            preview: {
                headers: ['ISIN', 'Name', 'Qty'],
                rows: [{ ISIN: 'RU00', Name: 'LUK', Qty: '10' }],
                rowCount: 5,
            },
            pdfProbe: { kind: 'broker_report' },
        });
        assert.equal(report.status, 'pass');
        assert.equal(report.ok, true);
    });

    it('fail при 0 строк', () => {
        const report = buildPdfParseValidationReport({
            preview: { headers: ['a'], rows: [], rowCount: 0 },
        });
        assert.equal(report.status, 'fail');
        assert.equal(report.ok, false);
    });

    it('skip при saved scenario', () => {
        const report = buildPdfParseValidationReport({
            preview: { headers: [], rows: [], rowCount: 0 },
            savedScenarioFound: true,
        });
        assert.equal(report.skipped, true);
        assert.equal(report.ok, true);
    });

    it('headerOverlap', () => {
        const overlap = headerOverlap(['ISIN', 'Qty'], ['isin', 'qty']);
        assert.ok(overlap >= 0.99);
    });

    it('dual_extract fail при низком overlap', () => {
        const report = buildPdfParseValidationReport({
            preview: {
                headers: ['A', 'B', 'C'],
                rows: [{ A: '1', B: '2', C: '3' }],
                rowCount: 3,
            },
            pdfProbe: { kind: 'broker_report' },
            dualExtract: { headerOverlap: 0.1, note: 'test' },
        });
        const dual = report.checks.find((c) => c.id === 'dual_extract');
        assert.equal(dual.status, 'fail');
    });
});
