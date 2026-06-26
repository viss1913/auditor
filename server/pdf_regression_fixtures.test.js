const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { probePdfKind, classifyPdfTextWithScores } = require('./pdf_probe');

const FIXTURES = path.join(__dirname, 'fixtures');

function readFixture(...parts) {
    const p = path.join(FIXTURES, ...parts);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p);
}

describe('pdf_regression_fixtures', () => {
    it('ATON broker report → broker_report', async () => {
        const buf = readFixture('broker_aton', 'client_24940000_01.12.2025_to_31.12.2025.pdf');
        if (!buf) return;
        const probe = await probePdfKind(buf, 'client_24940000_01.12.2025_to_31.12.2025.pdf');
        assert.equal(probe.kind, 'broker_report');
        assert.equal(probe.ambiguous, false);
        assert.ok(probe.confidence >= 0.65);
        assert.ok(['aton', 'unknown'].includes(probe.brokerSubtype));
    });

    it('Liman broker → broker_report', async () => {
        const name = 'Account Statement_LMC-308_OWN_42600268030801_2025-10-01_to_2025-10-31_English.pdf';
        const buf = readFixture('broker_liman', name);
        if (!buf) return;
        const probe = await probePdfKind(buf, name);
        assert.equal(probe.kind, 'broker_report');
        assert.ok(probe.confidence >= 0.5);
    });

    it('УПД tricky → upd_ediweb или unknown', async () => {
        const buf = readFixture('tricky', 'pavel', 'UPD_466_2025-02-03 [1YRxvO].pdf');
        if (!buf) return;
        const probe = await probePdfKind(buf, 'UPD_466_2025-02-03.pdf');
        assert.ok(['upd_ediweb', 'unknown'].includes(probe.kind));
    });

    it('classifyPdfTextWithScores returns alternatives array', () => {
        const profile = classifyPdfTextWithScores('ATON брокерск отчет');
        assert.ok(Array.isArray(profile.alternatives));
        assert.ok(typeof profile.confidence === 'number');
    });
});
