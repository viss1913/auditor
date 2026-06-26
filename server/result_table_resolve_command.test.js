const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { SNAPSHOT_ONLY_ACTIONS, buildSkipLlm } = require('./result_table_resolve_command');

describe('result_table_resolve_command', () => {
    it('SNAPSHOT_ONLY_ACTIONS включает replace и expand_ks', () => {
        assert.ok(SNAPSHOT_ONLY_ACTIONS.has('replace_values'));
        assert.ok(SNAPSHOT_ONLY_ACTIONS.has('expand_ks_analytics'));
        assert.ok(SNAPSHOT_ONLY_ACTIONS.has('undo_last'));
    });

    it('buildSkipLlm: expand_ks без LLM', () => {
        assert.equal(
            buildSkipLlm('разбери аналитику', { action: 'expand_ks_analytics' }),
            true
        );
    });
});
