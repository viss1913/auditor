const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const { probeUkLayout } = require('./uk_layout_probe');
const { checkUkParseSanity } = require('./uk_sanity');
const { runParseEngine, loadExampleRule } = require('./parse_engine');
const { applyScenario } = require('./scenarios/registry');
const { analyzeLayout } = require('./analyze_layout');

const FIXTURE = path.join(__dirname, 'fixtures', 'uk_card_mechel.xlsx');

if (!fs.existsSync(FIXTURE)) {
    execSync('node generate_uk_mechel.js', { cwd: path.join(__dirname, 'fixtures'), stdio: 'ignore' });
}

describe('uk_card mechel fixture', () => {
    it('probe выбирает quantity col 7, balance col 8', () => {
        const xlsx = require('xlsx');
        const wb = xlsx.readFile(FIXTURE);
        const data = xlsx.utils.sheet_to_json(wb.Sheets.TDSheet, { header: 1, defval: '' });
        const probe = probeUkLayout(data, { data_start_row: 7 });
        assert.equal(probe.quantity_column, 7);
        assert.equal(probe.balance_column, 8);
        assert.equal(probe.has_credit_91, true);
    });

    it('full parse: 3 строки, quantity 10/5, переоценка 91', () => {
        const layout = analyzeLayout(fs.readFileSync(FIXTURE), 'TDSheet', {
            fileName: 'карт 58.1_mechel.xlsx',
        });
        const rule = applyScenario('uk_card', layout);
        const out = runParseEngine(FIXTURE, rule);
        assert.equal(out.ok, true);
        assert.equal(out.rowCount, 3);

        const q10 = out.rows.find((r) => r.amount === 1083.5);
        assert.ok(q10);
        assert.equal(q10.quantity, 10);
        assert.equal(q10.credit_account, '76.07.2');
        assert.equal(q10.current_balance_bu, 117019539.25);
        assert.equal(q10.current_balance_qty, 17305836);
        assert.match(q10.operation_type, /Поступление/i);

        const rev = out.rows.find((r) => r.amount === 61);
        assert.ok(rev, 'переоценка 61 на 91');
        assert.equal(rev.credit_account, '91.01.10');

        const q5 = out.rows.find((r) => r.amount === 97515);
        assert.ok(q5);
        assert.equal(q5.quantity, 5);

        const sanity = checkUkParseSanity(out.rows, layout.uk_probe);
        assert.equal(sanity.issues.includes('quantity_like_balance'), false);
        assert.equal(sanity.issues.includes('missing_credit_91'), false);
    });

    it('trades mode: только 76, без 91', () => {
        const layout = analyzeLayout(fs.readFileSync(FIXTURE), 'TDSheet', {
            fileName: 'карт 58.1_mechel.xlsx',
        });
        layout.uk_mode = 'trades';
        const rule = applyScenario('uk_card', layout);
        const out = runParseEngine(FIXTURE, rule);
        assert.equal(out.rowCount, 2);
        assert.ok(!out.rows.some((r) => /^91/.test(r.credit_account)));
    });
});
