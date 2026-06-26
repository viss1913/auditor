const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { executeMartinTool, MARTIN_TOOL_SCHEMAS } = require('./martin_tools');
const { resolveAnswerRegex } = require('./orchestrator/answer_resolve');

describe('martin_tools', () => {
    it('schemas: основные tools определены', () => {
        const names = MARTIN_TOOL_SCHEMAS.map((t) => t.name);
        assert.ok(names.includes('answer_question'));
        assert.ok(names.includes('set_file_prefix'));
        assert.ok(names.includes('filter_table'));
    });

    it('executeMartinTool: set_file_prefix', async () => {
        const out = await executeMartinTool('set_file_prefix', { prefix: '1F018_' }, {});
        assert.equal(out.ok, true);
        assert.equal(out.filePrefix, '1F018_');
    });

    it('executeMartinTool: answer_question via regex context', async () => {
        const question = {
            id: 'pick_tree_flatten',
            options: [
                { value: 'confirm', label: 'Да, развернуть так' },
                { value: 'scenario:os_08_osv', label: 'Нет, это ОСВ 08' },
            ],
        };
        const out = await executeMartinTool(
            'answer_question',
            { question_id: 'pick_tree_flatten', answer_text: 'да разверни' },
            { currentQuestion: question, orchestratorAnswers: {} }
        );
        assert.equal(out.ok, true);
        assert.equal(out.value, 'confirm');
        assert.equal(out.orchestratorAnswers.pick_tree_flatten, 'confirm');
    });

    it('executeMartinTool: filter_table ok-check', async () => {
        const headers = ['debit_account', 'credit_account', 'name'];
        const out = await executeMartinTool(
            'filter_table',
            { filter_expression: 'оставь только где debit_account = 62.01' },
            { parsePreview: { headers, rows: [{ debit_account: '62.01' }] } }
        );
        assert.equal(out.ok, true);
        assert.equal(out.plan?.action, 'filter_rows');
    });

    it('resolveAnswerRegex совпадает с tool answer', () => {
        const q = {
            id: 'pick_scenario',
            options: [
                { value: 'os_01_flat', label: 'Плоская' },
                { value: 'os_01_hierarchy', label: 'С иерархией' },
            ],
        };
        assert.equal(resolveAnswerRegex('плоская таблица без дерева', q), 'os_01_flat');
    });
});
