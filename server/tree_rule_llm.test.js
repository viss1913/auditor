const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isTreeIntentMessage, crossCheckProposal, sanitizeLevels } = require('./tree_rule_llm');

describe('tree_rule_llm', () => {
    it('isTreeIntentMessage', () => {
        assert.equal(isTreeIntentMessage('лист = договор, разверни дерево'), true);
        assert.equal(isTreeIntentMessage('вытащи инвентарный'), false);
    });

    it('sanitizeLevels', () => {
        const levels = sanitizeLevels([
            { id: 'contract', target: 'Договор', patterns: ['^Договор\\s'] },
        ]);
        assert.equal(levels.length, 1);
        assert.equal(levels[0].id, 'contract');
    });

    it('crossCheckProposal предупреждает если нет договоров', () => {
        const w = crossCheckProposal(
            { profile_key: 'os_76_card', hierarchy: { levels: [{ id: 'contract' }] } },
            { clusterCounts: { counterparty: 2 } }
        );
        assert.ok(w.some((x) => /Договор/i.test(x)));
    });
});
