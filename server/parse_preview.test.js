const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const { runParseFull, runParsePreview } = require('./parse_preview');
const { sheetLoadFromMeta } = require('./excel_sheet_meta');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { applyScenario } = require('./scenarios/registry');
const { analyzeLayout } = require('./analyze_layout');

const MECHEL = path.join(__dirname, 'fixtures', 'uk_card_mechel.xlsx');

describe('parse_preview sheetLoad', () => {
    it('maxSourceRows: быстрее и меньше строк, чем полный парс', () => {
        if (!fs.existsSync(MECHEL)) return;
        const buf = fs.readFileSync(MECHEL);
        const loaded = readSheetWithMeta(buf, 'TDSheet', { fileName: 'uk.xlsx' });
        const sheetLoad = sheetLoadFromMeta(loaded);
        const layout = analyzeLayout(buf, 'TDSheet', { fileName: 'uk.xlsx', loaded });
        const rule = applyScenario('uk_card', layout);

        const quick = runParseFull(null, rule, { sheetLoad, maxSourceRows: 12 });
        const full = runParseFull(null, rule, { sheetLoad });
        assert.equal(quick.ok, true);
        assert.equal(full.ok, true);
        assert.ok(quick.rowCount <= full.rowCount);
        assert.ok(full.rowCount >= 3);

        const preview = runParsePreview(null, rule, 2, { sheetLoad, maxSourceRows: 12 });
        assert.equal(preview.rows.length, 2);
        assert.equal(preview.rowCount, quick.rowCount);
    });

    it('sheetLoad даёт тот же результат, что parse с диска', () => {
        if (!fs.existsSync(MECHEL)) return;
        const buf = fs.readFileSync(MECHEL);
        const loaded = readSheetWithMeta(buf, 'TDSheet', { fileName: 'uk.xlsx' });
        const sheetLoad = sheetLoadFromMeta(loaded);
        const layout = analyzeLayout(buf, 'TDSheet', { fileName: 'uk.xlsx', loaded });
        const rule = applyScenario('uk_card', layout);

        const fromLoad = runParseFull(null, rule, { sheetLoad });
        const tmp = path.join(require('os').tmpdir(), `auditor_parse_test_${Date.now()}.xlsx`);
        fs.writeFileSync(tmp, buf);
        try {
            const fromDisk = runParseFull(tmp, rule);
            assert.equal(fromLoad.rowCount, fromDisk.rowCount);
            assert.deepEqual(fromLoad.rows[0], fromDisk.rows[0]);
        } finally {
            try {
                fs.unlinkSync(tmp);
            } catch {
                /* ignore */
            }
        }
    });
});
