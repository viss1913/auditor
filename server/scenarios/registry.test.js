const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { analyzeLayout } = require('../analyze_layout');
const {
    detectSuggestedScenario,
    applyScenario,
    resolveScenarioFromMessage,
    listScenarios,
} = require('./registry');
const { runParseEngine } = require('../parse_engine');
const { validateParsingRuleV2 } = require('../parsing_rule_v2_validate');

const sampleXlsx = path.join(__dirname, '..', '..', 'Пример для ТЗ ФАС- ОС.xlsx');

describe('scenarios/registry', () => {
    it('listScenarios возвращает presets', () => {
        const list = listScenarios();
        assert.ok(list.some((s) => s.id === 'os_01_flat'));
        assert.ok(list.some((s) => s.id === 'os_01_hierarchy'));
    });

    it('detectSuggestedScenario → needs_user_choice на FAS 01', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const detected = detectSuggestedScenario(layout, null);
        assert.equal(detected.needsUserChoice, true);
        assert.deepEqual(detected.candidates, ['os_01_flat', 'os_01_hierarchy']);
    });

    it('resolveScenarioFromMessage: плоско / с группой', () => {
        assert.equal(resolveScenarioFromMessage('плоская таблица'), 'os_01_flat');
        assert.equal(resolveScenarioFromMessage('с группой и ОП'), 'os_01_hierarchy');
    });

    it('FAS flat: только тип, без Группа', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const rule = applyScenario('os_01_flat', layout, null);
        const v = validateParsingRuleV2(rule);
        assert.equal(v.ok, true);
        const metricCols = rule.columns.filter((c) => c.source?.type === 'metric');
        assert.ok(metricCols.some((c) => c.source.measure === 'cost_open'));
        assert.ok(metricCols.some((c) => c.source.measure === 'residual_close'));
        const out = runParseEngine(sampleXlsx, rule);
        assert.ok(out.rowCount >= 15);
        const row = out.rows.find((r) => /80-000722/.test(r['тип'] || ''));
        assert.ok(row);
        assert.ok(!('Группа' in row));
        assert.ok(!('Узел' in row));
    });

    it('FAS Profsoyuznaya: метрики на начало и конец', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const rule = applyScenario('os_01_hierarchy', layout, null);
        const out = runParseEngine(sampleXlsx, rule);
        const row = out.rows.find((r) => /Профсоюзн/i.test(r['ОС'] || ''));
        assert.ok(row);
        const openKey = Object.keys(row).find((k) => /начало.*Стоимость/i.test(k));
        const closeKey = Object.keys(row).find((k) => /конец.*Стоимость/i.test(k));
        assert.ok(openKey);
        assert.ok(closeKey);
        assert.equal(row[openKey], 8098013.37);
        assert.equal(row[closeKey], 8098013.37);
        assert.equal(row['Группа'], 'Здания');
        assert.equal(row['Узел'], 'КЦ');
        assert.equal(row['Подразделение'], 'ОП КЦ');
    });

    it('FAS hierarchy: 80-000722 полный path', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const rule = applyScenario('os_01_hierarchy', layout, null);
        const out = runParseEngine(sampleXlsx, rule);
        const row = out.rows.find((r) => /80-000722/.test(r['ОС'] || ''));
        assert.ok(row);
        assert.equal(row['Группа'], 'Здания');
        assert.equal(row['Узел'], 'РТК Волгоград');
        assert.equal(row['Подразделение'], 'ОП АБГ-Волгоград');
    });
});
