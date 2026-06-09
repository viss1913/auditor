const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadExample } = require('./ai_prompts');
const { applyV2HintsFromUserMessage } = require('./rule_hints');

describe('rule_hints delete column intent', () => {
    it('удали колонку Группа -> удаляется только group', () => {
        const base = loadExample('os_hierarchy_01.json');
        // sanity: ensure group is present before hint
        assert.ok(base.columns.some((c) => c.source?.field === 'group'));

        const next = applyV2HintsFromUserMessage(
            JSON.parse(JSON.stringify(base)),
            'удали колонку Группа',
            { column_catalog: { report_year: '2024' } },
            { report_year: '2024' }
        );

        assert.ok(!next.columns.some((c) => c.source?.field === 'group'));
        assert.ok(next.columns.some((c) => c.source?.field === 'asset_name'));
    });

    it('убери колонку остаточная на конец -> удаляется metric residual_close', () => {
        const base = loadExample('os_hierarchy_01.json');
        assert.ok(base.columns.some((c) => c.source?.measure === 'residual_close'));

        const next = applyV2HintsFromUserMessage(
            JSON.parse(JSON.stringify(base)),
            'убери колонку остаточная на конец',
            { column_catalog: { report_year: '2024' } },
            { report_year: '2024' }
        );

        assert.ok(!next.columns.some((c) => c.source?.measure === 'residual_close'));
        assert.ok(next.columns.some((c) => c.source?.measure === 'amort_charge'));
    });

    it('удалим колонку Группа -> тоже удаляет group', () => {
        const base = loadExample('os_hierarchy_01.json');
        const next = applyV2HintsFromUserMessage(
            JSON.parse(JSON.stringify(base)),
            'так давай удалим колонку Группа',
            { column_catalog: { report_year: '2024' } },
            { report_year: '2024' }
        );
        assert.ok(!next.columns.some((c) => c.source?.field === 'group'));
    });
});

