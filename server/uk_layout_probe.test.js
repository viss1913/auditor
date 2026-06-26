const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const xlsx = require('xlsx');

const {
    probeUkLayout,
    buildUkColumnVariants,
    detectUkHeaderMeta,
    looksLikeAccountCell,
} = require('./uk_layout_probe');
const { analyzeLayout } = require('./analyze_layout');
const { applyScenario } = require('./scenarios/registry');
const { runParseEngine } = require('./parse_engine');
const { previewFailsFlatSanity } = require('./flat_parse_sanity');

const DUAL_FIXTURE = path.join(__dirname, 'fixtures', 'uk_card_dual_analytics.xlsx');

if (!fs.existsSync(DUAL_FIXTURE)) {
    execSync('node generate_uk_dual_analytics.js', {
        cwd: path.join(__dirname, 'fixtures'),
        stdio: 'ignore',
    });
}

describe('uk_layout_probe dual analytics', () => {
    it('detectUkHeaderMeta: Аналитика Дт/Кт', () => {
        const wb = xlsx.readFile(DUAL_FIXTURE);
        const data = xlsx.utils.sheet_to_json(wb.Sheets.TDSheet, { header: 1, defval: '' });
        const meta = detectUkHeaderMeta(data);
        assert.equal(meta.dualAnalytics, true);
        assert.equal(meta.analyticsDtCol, 2);
        assert.equal(meta.analyticsKtCol, 3);
    });

    it('probe: amount col 7, credit col 8 (не счёт 76.07.2 в amount)', () => {
        const wb = xlsx.readFile(DUAL_FIXTURE);
        const data = xlsx.utils.sheet_to_json(wb.Sheets.TDSheet, { header: 1, defval: '' });
        const probe = probeUkLayout(data);
        assert.equal(probe.dual_analytics, true);
        assert.equal(probe.amount_column, 7);
        assert.equal(probe.credit_account_column, 8);
        assert.equal(probe.preview_rows[0]?.amount, '1083.50');
        assert.equal(probe.preview_rows[0]?.credit, '76.07.2');
        assert.equal(looksLikeAccountCell(probe.preview_rows[0]?.amount), false);
    });

    it('buildUkColumnVariants: dual_analytics первым', () => {
        const wb = xlsx.readFile(DUAL_FIXTURE);
        const data = xlsx.utils.sheet_to_json(wb.Sheets.TDSheet, { header: 1, defval: '' });
        const probe = probeUkLayout(data);
        const variants = buildUkColumnVariants(probe);
        assert.equal(variants[0].variant, 'dual_analytics_wide');
        assert.equal(variants[0].amount_column, 7);
        assert.equal(variants[0].credit_account_column, 9);
        const compact = variants.find((v) => v.variant === 'dual_analytics_compact');
        assert.ok(compact);
        assert.equal(compact.credit_account_column, 8);
    });

    it('full parse dual analytics: amount 1083.5, credit 76.07.2', () => {
        const layout = analyzeLayout(fs.readFileSync(DUAL_FIXTURE), 'TDSheet', {
            fileName: 'карт 58.1_НР.xlsx',
        });
        const rule = applyScenario('uk_card', layout);
        const out = runParseEngine(DUAL_FIXTURE, rule);
        assert.equal(out.ok, true);
        assert.equal(out.rowCount, 1);
        const row = out.rows[0];
        assert.equal(row.amount, 1083.5);
        assert.equal(row.credit_account, '76.07.2');
        assert.equal(row.quantity, 10);
        assert.equal(row['Аналитика Дт'], 'Мечел, ап, 2-01-55005-E');
        assert.match(String(row['Аналитика Кт'] || ''), /СБ-Брокер/);
        assert.equal(previewFailsFlatSanity('uk_card', out, layout), false);
    });
});
