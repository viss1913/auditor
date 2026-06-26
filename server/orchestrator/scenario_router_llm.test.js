const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    resolveScenarioWithLlm,
    normalizeRouterResponse,
    reconcileWithClassifier,
    classifierFallbackScenario,
    shouldSkipLlmRouter,
} = require('./scenario_router_llm');
const { buildExcelStructurePack } = require('../universal_parse/structure_pack');
const { buildSheetContext } = require('../sheet_parse_orchestrator');
const { getCachedScenario, setCachedScenario, CACHE_PATH } = require('../universal_parse/rule_cache');

describe('scenario_router_llm', () => {
    const mechel = path.join(__dirname, 'fixtures', 'uk_card_mechel.xlsx');

    it('classifierFallbackScenario: uk_journal_58 → uk_card', () => {
        if (!fs.existsSync(mechel)) return;
        const buf = fs.readFileSync(mechel);
        const ctx = buildSheetContext({
            pool: null,
            file: { buffer: buf, originalname: 'карт 58.1_HP.xlsx' },
            sheetName: 'TDSheet',
        });
        const fallback = classifierFallbackScenario(ctx.structurePack);
        assert.equal(fallback, 'uk_card');
    });

    it('normalizeRouterResponse: invalid id → fallback classifier', () => {
        const pack = {
            structure_id: 'uk_journal_58',
            ontology: { row_pattern: 'bu_kol_pairs', layout_type: 'fixed_columns', has_tree: false },
            classifier_ranked: [{ structure_id: 'uk_journal_58', confidence: 0.95 }],
        };
        const normalized = normalizeRouterResponse({ scenarioId: 'bogus_id', confidence: 0.9 }, pack);
        assert.equal(normalized.scenarioId, 'uk_card');
    });

    it('reconcileWithClassifier: низкая уверенность LLM → classifier override', () => {
        const pack = {
            structure_id: 'uk_journal_58',
            classifier_ranked: [{ structure_id: 'uk_journal_58', confidence: 0.96 }],
            ontology: { row_pattern: 'bu_kol_pairs' },
        };
        const router = {
            scenarioId: 'ks_card_composite_raw',
            confidence: 0.6,
            reasoning: 'test',
            fallback: null,
            source: 'llm',
        };
        const reconciled = reconcileWithClassifier(router, pack);
        assert.equal(reconciled.scenarioId, 'uk_card');
        assert.equal(reconciled.source, 'classifier_override');
    });

    it('shouldSkipLlmRouter: uk_journal_58 с высокой уверенностью', () => {
        if (!fs.existsSync(mechel)) return;
        const buf = fs.readFileSync(mechel);
        const ctx = buildSheetContext({
            pool: null,
            file: { buffer: buf, originalname: 'карт 58.1_HP.xlsx' },
            sheetName: 'TDSheet',
        });
        assert.equal(shouldSkipLlmRouter(ctx.structure, ctx.structurePack), true);
    });

    it('resolveScenarioWithLlm skipLlm → classifier без API', async () => {
        if (!fs.existsSync(mechel)) return;
        const buf = fs.readFileSync(mechel);
        const ctx = buildSheetContext({
            pool: null,
            file: { buffer: buf, originalname: 'карт 58.1_HP.xlsx' },
            sheetName: 'TDSheet',
        });
        const result = await resolveScenarioWithLlm(ctx.structurePack, { skipLlm: true });
        assert.equal(result.scenarioId, 'uk_card');
        assert.equal(result.source, 'classifier_fallback');
    });

    it('classifierFallbackScenario: journal_1c top, ontology bu_kol → uk_card', () => {
        const fallback = classifierFallbackScenario({
            structure_id: 'journal_1c',
            classifier_ranked: [{ structure_id: 'journal_1c', confidence: 0.98 }],
            ontology: {
                row_pattern: 'bu_kol_pairs',
                account_signals: { bu58: 5 },
                suggested_scenario: 'uk_card',
            },
        });
        assert.equal(fallback, 'uk_card');
    });

    it('кэш fingerprint: set/get scenario', () => {
        const fp = { test: 'scenario_cache', bu58: 3 };
        setCachedScenario(fp, {
            scenarioId: 'uk_card',
            confidence: 0.95,
            reasoning: 'test cache',
        });
        const cached = getCachedScenario(fp);
        assert.equal(cached.scenarioId, 'uk_card');
        assert.equal(cached.confidence, 0.95);
    });

    it('reconcileWithClassifier: кэш os_08 на hierarchy_os_01 → os_01_hierarchy', () => {
        const pack = {
            structure_id: 'hierarchy_os_01',
            classifier_ranked: [{ structure_id: 'hierarchy_os_01', confidence: 0.9 }],
            ontology: { layout_type: 'hierarchy_rows', has_tree: true },
        };
        const router = {
            scenarioId: 'os_08_osv',
            confidence: 0.95,
            reasoning: 'cache hit',
            source: 'cache',
        };
        const reconciled = reconcileWithClassifier(router, pack);
        assert.equal(reconciled.scenarioId, 'os_01_hierarchy');
        assert.match(reconciled.source, /classifier/);
    });
});
