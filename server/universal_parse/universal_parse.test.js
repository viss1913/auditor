const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { probeDocument } = require('./document_probe');
const { validateExtractionRuleV1 } = require('./extraction_rule_v1_validate');
const { buildOS01HierarchyRows } = require('../fixtures/generators/node/os01_base');
const XLSX = require('xlsx');

describe('universal_parse', () => {
    it('probeDocument excel: os_depreciation_01', async () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildOS01HierarchyRows()), 'Лист1');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const probe = await probeDocument(buf, 'os01.xlsx');
        assert.equal(probe.sourceKind, 'excel');
        assert.equal(probe.layoutMeta.recommended.profile_hint, 'os_depreciation_01');
        assert.ok(probe.structurePack.preview);
    });

    it('probeDocument pdf: upd_ediweb', async () => {
        const p = path.join(__dirname, '..', '..', 'docs', 'Павел', 'UPD_69_2025-01-09 [Xg9AgY].pdf');
        const buf = fs.readFileSync(p);
        const probe = await probeDocument(buf, 'UPD_69.pdf');
        assert.equal(probe.sourceKind, 'pdf');
        assert.equal(probe.pdfProbe.kind, 'upd_ediweb');
    });

    it('ExtractionRule v1 validator rejects eval', () => {
        const v = validateExtractionRuleV1({
            rule_schema_version: 1,
            meta: { name: 'bad', source_type: 'pdf' },
            anchors: { x: { pattern: 'eval(1)' } },
        });
        assert.equal(v.ok, false);
    });
});
