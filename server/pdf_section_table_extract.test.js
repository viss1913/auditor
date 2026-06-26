const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pickSectionExtract } = require('./universal_parse/pdf_section_table_extract');
const { getCachedSectionLayout, setCachedSectionLayout, buildFileLayoutFingerprint } = require('./universal_parse/rule_cache');

const DECEMBER = path.join(__dirname, 'fixtures', 'broker_aton', 'client_24940000_01.12.2025_to_31.12.2025.pdf');
const OCTOBER = path.join(__dirname, 'fixtures', 'broker_aton', 'client_24951000_01.10.2025_to_31.10.2025.pdf');

describe('pdf_section_table_extract', () => {
    it('pickSectionExtract: trades grid с полной шириной побеждает regex при близком row count', () => {
        const grid = {
            ok: true,
            headers: Array.from({ length: 27 }, (_, i) => `col_${i}`),
            rows: Array.from({ length: 151 }, () => ({ col_3: 'mcxs1, 01.01.25, 12:00:00' })),
            confidence: 0.85,
            method: 'pdfjs_grid_native_headers',
            meta: { columns: 27 },
        };
        const regex = {
            ok: true,
            headers: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
            rows: Array.from({ length: 158 }, () => ({ a: 1 })),
            confidence: 0.85,
            method: 'aton_trades',
        };
        const picked = pickSectionExtract(grid, regex, { sectionId: 'trades' });
        assert.equal(picked.method, 'pdfjs_grid_native_headers');
        assert.equal(picked.headers.length, 27);
    });

    it('pickSectionExtract: grid с большим числом колонок побеждает regex', () => {
        const grid = {
            ok: true,
            headers: ['a', 'b', 'c', 'd', 'e', 'f'],
            rows: [{ a: 1 }, { a: 2 }],
            confidence: 0.8,
            method: 'pdfjs_grid_native_headers',
            meta: { columns: 6 },
        };
        const regex = {
            ok: true,
            headers: ['a', 'b', 'c', 'd', 'e'],
            rows: [{ a: 1 }, { a: 2 }],
            confidence: 0.85,
            method: 'aton_encumbered',
        };
        const picked = pickSectionExtract(grid, regex);
        assert.equal(picked.method, 'pdfjs_grid_native_headers');
        assert.equal(picked.headers.length, 6);
    });

    it('декабрьский encumbered: ≥8 колонок, чистое имя ЦБ', async () => {
        assert.ok(fs.existsSync(DECEMBER));
        const buf = fs.readFileSync(DECEMBER);
        const { probePdfKind } = require('./pdf_probe');
        const { extractBrokerPdfSectionTables } = require('./universal_parse/pdf_broker_sections');
        const probe = await probePdfKind(buf, path.basename(DECEMBER));
        const sections = await extractBrokerPdfSectionTables(probe.lines, '', {
            brokerSubtype: 'aton',
            pdfBuffer: buf,
        });
        const enc = sections.find((s) => s.id === 'encumbered');
        assert.ok(enc);
        assert.ok(enc.headers.length >= 12, `encumbered cols: ${enc.headers.length}`);
        const cbKey = enc.headers.find((h) => /ЦБ|ISIN/i.test(h)) || enc.headers[0];
        assert.equal(enc.rows[0][cbKey], 'ВТБ(1/10000)(C)/RU000A0JP5V6/10401000B');
    });

    it('октябрьский trades: ≥150 строк', async () => {
        assert.ok(fs.existsSync(OCTOBER));
        const buf = fs.readFileSync(OCTOBER);
        const { probePdfKind } = require('./pdf_probe');
        const { extractBrokerPdfSectionTables } = require('./universal_parse/pdf_broker_sections');
        const probe = await probePdfKind(buf, path.basename(OCTOBER));
        const sections = await extractBrokerPdfSectionTables(probe.lines, '', {
            brokerSubtype: 'aton',
            pdfBuffer: buf,
        });
        const trades = sections.find((s) => s.id === 'trades');
        assert.ok(trades?.rows.length >= 140);
        assert.ok(trades?.rows.length <= 165, `trades rows: ${trades?.rows.length}`);
        assert.ok(trades?.headers.length >= 24, `trades cols: ${trades?.headers.length}`);
        const dealKey =
            trades.headers.find((h) => /сделк.*дата/i.test(String(h))) ||
            trades.headers.find((h) => /col_3/i.test(String(h)));
        const dealVal = String(trades.rows[0][dealKey] || '');
        assert.match(dealVal, /mcxs\d+/i);
        assert.match(dealVal, /\d{2}\.\d{2}\.\d{2}/);
    });

    it('кэш layout: save и read per file', () => {
        const fpA = buildFileLayoutFingerprint(Buffer.from('pdf-a'), 'a.pdf');
        const fpB = buildFileLayoutFingerprint(Buffer.from('pdf-b'), 'b.pdf');
        setCachedSectionLayout('aton', 'enc_test', fpA, {
            headers: ['ЦБ', 'Кол'],
            columnCenters: [30, 240],
            dataStart: 5,
        });
        assert.ok(getCachedSectionLayout('aton', 'enc_test', fpA)?.columnCenters?.length === 2);
        assert.equal(getCachedSectionLayout('aton', 'enc_test', fpB), null);
    });
});
