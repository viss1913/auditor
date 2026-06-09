const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    isAccountCard76,
    isAccountCard76Data,
    detectSuggestedScenario,
    inferScenarioFromRule,
    applyScenario,
} = require('./registry');

describe('os_76 vs os_08 routing', () => {
    it('isAccountCard76Data по содержимому листа', () => {
        const data = [
            ['Счет, Наименование счета'],
            ['Подразделение'],
            ['Контрагенты'],
            ['Договоры'],
            ['76, Расчеты'],
            ['Подразделение 1'],
            ['Контрагент10 611'],
            ['Договор 1', 0, 0, 10, 10],
        ];
        assert.equal(isAccountCard76Data(data, 4), true);
    });

    it('detectSuggestedScenario: карточка 76, не ОСВ 08', () => {
        const layoutMeta = {
            recommended: { layout_type: 'hierarchy_osv', profile_hint: 'os_account_card_76' },
            column_catalog: { layout_type: 'hierarchy_osv', hierarchy_legend: true },
            tree_inference: { profileId: 'account_card', clusterCounts: { contract: 2, counterparty: 1 } },
        };
        const { scenarioId } = detectSuggestedScenario(layoutMeta, null);
        assert.equal(scenarioId, 'os_76_account_card');
    });

    it('inferScenarioFromRule: hierarchy_osv с договором → 76', () => {
        const rule = {
            meta: { profile_hint: 'os_account_card' },
            layout: { layout_type: 'hierarchy_osv' },
            columns: [
                { target: 'Счёт, наименование счета' },
                { target: 'Контрагент' },
                { target: 'Договор' },
            ],
        };
        assert.equal(inferScenarioFromRule(rule), 'os_76_account_card');
    });

    it('applyLayoutMeta: КС-лист не ломает hierarchy_osv для 76', () => {
        const { applyLayoutMeta, layoutTypeForScenario } = require('./registry');
        const rule = { meta: {}, layout: { layout_type: 'hierarchy_osv' } };
        applyLayoutMeta(
            rule,
            { recommended: { layout_type: 'fixed_columns' } },
            { layout_type: 'fixed_columns' },
            'os_76_account_card'
        );
        assert.equal(rule.layout.layout_type, 'hierarchy_osv');
        assert.equal(layoutTypeForScenario('os_76_account_card'), 'hierarchy_osv');
    });

    it('applyScenario os_76: колонки без Объект', () => {
        const layoutMeta = {
            sheetName: 'Исходная ОСВ',
            column_catalog: { data_start_row: 4, name_column: { index: 0 }, layout_type: 'hierarchy_osv' },
            recommended: { layout_type: 'hierarchy_osv' },
        };
        const rule = applyScenario('os_76_account_card', layoutMeta, null);
        const targets = rule.columns.map((c) => c.target);
        assert.ok(targets.includes('Договор'));
        assert.ok(targets.includes('Контрагент'));
        assert.ok(!targets.includes('Объект'));
        assert.equal(rule.layout.data_start_row, 4);
    });
});
