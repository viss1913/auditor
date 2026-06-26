const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildResultTablePlannerPrompt, formatChatHistory, sanitizePlan } = require('./result_table_llm');

describe('result_table_llm chat context', () => {
    it('formatChatHistory включает user и assistant', () => {
        const text = formatChatHistory([
            { role: 'user', content: 'замени Зачисление ЦБ на покупка' },
            { role: 'assistant', content: 'Заменила 1 ячейку' },
            { role: 'user', content: 'а теперь списание на продажа' },
        ]);
        assert.match(text, /user: замени Зачисление/i);
        assert.match(text, /assistant: Заменила/i);
    });

    it('buildResultTablePlannerPrompt содержит блок диалога', () => {
        const prompt = buildResultTablePlannerPrompt({
            message: 'а теперь то же для списания',
            headers: ['operationType', 'name'],
            samplesByHeader: { operationType: ['Списание ЦБ'] },
            chatHistory: [{ role: 'user', content: 'замени зачисление на покупка' }],
            activeFilter: null,
        });
        assert.match(prompt, /Недавний диалог/);
        assert.match(prompt, /замени зачисление/i);
    });

    it('sanitizePlan сохраняет filters из плана LLM', () => {
        const plan = sanitizePlan(
            {
                action: 'filter_rows',
                filters: [{ column: 'name', op: 'contains', value: 'ВТБ' }],
                mode: 'keep',
            },
            ['name', 'operationType']
        );
        assert.equal(plan.action, 'filter_rows');
        assert.equal(plan.filters.length, 1);
    });
});
