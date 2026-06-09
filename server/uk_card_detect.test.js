const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const { detectUkCard, isUkDateLabel } = require('./uk_card_detect');
const { analyzeLayout } = require('./analyze_layout');
const { applyScenario } = require('./scenarios/registry');

function buildUkRows({ withNoiseInCol0 = false } = {}) {
    const rows = [];
    if (withNoiseInCol0) {
        rows.push(['Контрагент X', '', '', '', '', '', '', '', '', '']);
        rows.push(['Договор 123', '', '', '', '', '', '', '', '', '']);
    }
    for (let i = 0; i < 7; i++) rows.push(['', '', '', '', '', '', '', '', '', '']);
    for (let i = 0; i < 20; i++) {
        rows.push(['30.12.2024', '', '', `Paper ${i}`, '', 'БУ', '58.01', 100 + i, '', '76.01']);
        rows.push(['', '', '', '', '', 'Кол.', '', '', 25, '']);
    }
    return rows;
}

describe('uk_card_detect', () => {
    it('isUkDateLabel отсекает даты', () => {
        assert.equal(isUkDateLabel('30.12.2024'), true);
        assert.equal(isUkDateLabel('76.01'), false);
    });

    it('detectUkCard по структуре и имени файла', () => {
        const rows = buildUkRows();
        const d = detectUkCard(rows, 'карт 58.1_HP.xlsx');
        assert.equal(d.isUk, true);
        assert.ok(d.confidence >= 0.96);
    });

    it('analyzeLayout: УК не предлагает дерево 76 даже с Контрагент/Договор в col A', () => {
        const rows = buildUkRows({ withNoiseInCol0: true });
        const ws = xlsx.utils.aoa_to_sheet(rows);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'TDSheet');
        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

        const layout = analyzeLayout(buf, 'TDSheet', { fileName: 'карт 58.1_HP.xlsx' });
        assert.equal(layout.recommended.profile_hint, 'uk_card');
        assert.equal(layout.tree_inference.examples.length, 0);
        assert.equal(layout.tree_inference.profileId, 'generic');

        const rule = applyScenario('uk_card', layout);
        assert.equal(rule.layout.layout_type, 'fixed_columns');
        assert.equal(rule.conditions.debit_account_prefix, '58.01');
        assert.equal(rule.conditions.mode, 'full');
    });

    it('fixture uk_sample.xlsx → uk_card сценарий', () => {
        const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'uk_sample.xlsx'));
        const layout = analyzeLayout(buf, null, { fileName: 'карт 58.1_HP.xlsx' });
        assert.equal(layout.recommended.profile_hint, 'uk_card');
        const rule = applyScenario('uk_card', layout);
        assert.equal(rule.multi_row.indicator_value, 'Кол.');
    });
});
