const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { analyzeLayout } = require('../analyze_layout');
const { buildSessionPlan } = require('./session_plan');
const { applyScenario } = require('../scenarios/registry');

const sampleXlsx = path.join(__dirname, '..', '..', 'Пример для ТЗ ФАС- ОС.xlsx');

describe('orchestrator/session_plan', () => {
    it('FAS 01: autostart без pick_scenario — сценарий из детекта', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const plan = buildSessionPlan(layout, null, null, {
            scenarioIdParam: null,
            userMessage: '',
            answers: {},
            savedRules: [],
        });

        assert.equal(plan.needsUserInput, false);
        assert.ok(plan.sessionState.scenarioId);
    });

    it('FAS 01: applyAnswer(pick_scenario) resolves and becomes ready', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');

        const plan = buildSessionPlan(layout, null, null, {
            scenarioIdParam: null,
            userMessage: '',
            answers: {},
            savedRules: [],
            autostart: false,
        });

        assert.equal(plan.needsUserInput, false);
        assert.ok(plan.sessionState.scenarioId);

        const { applyAnswer, isReadyToParse } = require('./session_plan');
        const next = applyAnswer(plan, 'pick_scenario', 'os_01_hierarchy');
        assert.equal(next.needsUserInput, false);
        assert.equal(next.sessionState.scenarioId, 'os_01_hierarchy');
        assert.equal(isReadyToParse(next, null), true);
    });

    it('FAS 01: composite extraction asks pick_composite_column', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const currentRule = applyScenario('os_01_hierarchy', layout, null);
        const plan = buildSessionPlan(layout, null, currentRule, {
            scenarioIdParam: null,
            userMessage: 'вытащи инвентарный номер из колонки',
            answers: {},
            savedRules: [],
        });

        assert.equal(plan.needsUserInput, true);
        assert.ok(plan.currentQuestion);
        assert.equal(plan.currentQuestion.id, 'pick_composite_column');
        assert.ok(Array.isArray(plan.currentQuestion.options));
        assert.ok(plan.currentQuestion.options.length >= 1);
    });

    it('FAS 01: composite extraction asks pick_composite_field after column choice', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const currentRule = applyScenario('os_01_hierarchy', layout, null);
        const plan = buildSessionPlan(layout, null, currentRule, {
            scenarioIdParam: null,
            userMessage: 'вытащи инвентарный номер из колонки',
            answers: { compositeColumn: 2, compositeExtracts: [] },
            savedRules: [],
        });

        assert.equal(plan.needsUserInput, true);
        assert.ok(plan.currentQuestion);
        assert.equal(plan.currentQuestion.id, 'pick_composite_field');
        assert.ok(plan.currentQuestion.options.some((o) => o.value === 'inventory_number'));
    });

    it('FAS 01: savedRule bypasses pick_scenario', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');

        const saved = applyScenario('os_01_hierarchy', layout, null);
        const plan = buildSessionPlan(layout, null, null, {
            scenarioIdParam: null,
            userMessage: '',
            answers: {},
            savedRules: [{ id: 1, rule_json: saved }],
        });

        assert.equal(plan.needsUserInput, false);
        assert.equal(plan.sessionState.scenarioId, 'os_01_hierarchy');
    });
});

