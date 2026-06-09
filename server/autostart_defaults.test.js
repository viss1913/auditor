const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeLayout } = require('./analyze_layout');
const { applyAutostartDefaults, shouldAutoFlattenTree } = require('./autostart_defaults');

const FIXTURE_76 = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('autostart_defaults', () => {
    it('fixture 76: дерево → pick_tree_flatten confirm', () => {
        const buf = fs.readFileSync(FIXTURE_76);
        const layout = analyzeLayout(buf, 'Исходная ОСВ', { fileName: 'Пример по сч 76.xlsx' });
        assert.equal(shouldAutoFlattenTree(layout), true);
        const answers = applyAutostartDefaults(layout, {});
        assert.equal(answers.pick_tree_flatten, 'confirm');
        assert.equal(answers.scenarioId, 'os_76_account_card');
    });
});
