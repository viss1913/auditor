const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { probePdfKind, detectBrokerSubtype } = require('./pdf_probe');
const {
    extractBrokerPdfSectionTables,
    shouldUseMultiTableBrokerParse,
} = require('./universal_parse/pdf_broker_sections');

const LMC_PDF = path.join(
    __dirname,
    'fixtures',
    'broker_liman',
    'Account Statement_LMC-308_OWN_42600268030801_2025-10-01_to_2025-10-31_English.pdf'
);
const LMC_PDF_CURSOR =
    'c:/Users/User/AppData/Roaming/Cursor/User/workspaceStorage/a7a546b122918814567298d87a2d2421/pdfs/f0faeb2d-9299-4c26-8c84-a7557acfd1a5/Account Statement_LMC-308_OWN_42600268030801_2025-10-01_to_2025-10-31_English.pdf';

function resolveLmcFixture() {
    if (fs.existsSync(LMC_PDF)) return LMC_PDF;
    if (fs.existsSync(LMC_PDF_CURSOR)) return LMC_PDF_CURSOR;
    return null;
}

describe('detectBrokerSubtype — LMC', () => {
    it('Account Statement_LMC → liman', () => {
        assert.equal(
            detectBrokerSubtype(
                'INVESTMENT ACCOUNT STATEMENT',
                'Account Statement_LMC-308_OWN_42600268030801_2025-10-01_to_2025-10-31_English.pdf',
                ''
            ),
            'liman'
        );
    });
});

describe('LMC / Landmark Capital broker PDF', () => {
    it('cash balance + account info', async () => {
        const pdfPath = resolveLmcFixture();
        if (!pdfPath) return;

        const buf = fs.readFileSync(pdfPath);
        const name = path.basename(pdfPath);
        const probe = await probePdfKind(buf, name);

        assert.equal(probe.kind, 'broker_report');
        assert.equal(probe.brokerSubtype, 'liman');

        const sections = await extractBrokerPdfSectionTables(probe.lines, '', {
            brokerSubtype: probe.brokerSubtype,
            pdfBuffer: buf,
            fileName: name,
        });

        assert.ok(sections.length >= 2);
        assert.ok(shouldUseMultiTableBrokerParse(sections, ''));

        const cash = sections.find((s) => s.id === 'cash_balance');
        const account = sections.find((s) => s.id === 'account_info');

        assert.ok(cash?.rows.length >= 10, `cash rows: ${cash?.rows.length}`);
        assert.equal(cash.rows[0]['Line item'], 'Opening Balance');
        assert.equal(cash.rows[0].USD, '1,411.73');
        assert.ok(cash.rows.some((r) => r['Line item'] === 'Closing Balance'));
        assert.ok(cash.rows.some((r) => r.RUB === '-96,000.00'));

        assert.ok(account?.rows.length >= 5);
        assert.ok(account.rows.some((r) => r.Field === 'Client Name' && /Solar/i.test(r.Value)));
        assert.ok(account.rows.some((r) => r.Field === 'Client Code' && r.Value === 'LMC-308'));
    });
});
