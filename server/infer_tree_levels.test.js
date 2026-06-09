const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { inferTreeLevels } = require('./infer_tree_levels');

describe('infer_tree_levels', () => {
    it('карточка 76: account_card + примеры path', () => {
        const data = [
            ['76.01.1, Расчеты'],
            ['Подразделение 1'],
            ['Контрагент 10'],
            ['Договор 1', 1, 0, 0, 0, 0, 0],
        ];
        const inf = inferTreeLevels(data, {
            recommended: { layout_type: 'hierarchy_osv' },
            column_catalog: { name_column: { index: 0 } },
        });
        assert.equal(inf.profileId, 'account_card');
        assert.equal(inf.profileKey, 'os_76_card');
        assert.ok(inf.examples.length >= 1);
    });
});
