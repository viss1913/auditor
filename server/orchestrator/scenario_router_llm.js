/**
 * LLM scenario router: structure pack → scenarioId (закрытый список).
 */
const { chatCompletion, extractJsonFromLlmContent } = require('../llm_client');
const {
    ROUTER_ALLOWED_IDS,
    SCENARIO_ROUTER_SYSTEM,
    buildScenarioRouterUserPrompt,
} = require('../ai_prompts_scenario_router');
const { getCachedScenario, setCachedScenario } = require('../universal_parse/rule_cache');
const { STRUCTURE_TO_SCENARIO, resolveScenarioFromOntology } = require('../structure_ontology');
const { structureIdToScenarioId } = require('../structure_classifier');
const { isLlmRouterEnabled } = require('../martin_flags');

const ALLOWED_SCENARIOS = {
    journal_1c: ['ks_card_composite_raw', 'ks_card', 'ks_card_flat', 'uk_card'],
    uk_journal_58: ['uk_card', 'ks_card_composite_raw', 'ks_card'],
    uk_osv_58: ['uk_osv_58'],
    tree_account_76: ['os_76_account_card'],
    tree_os_08: ['os_08_osv'],
    hierarchy_os_01: ['os_01_hierarchy', 'os_01_flat'],
    revenue_osv_90: ['revenue_osv_90', 'revenue_period', 'revenue_osv'],
    flat_osv: ['osv_flat_processed', 'osv_flat'],
    wide_years: ['os_01_flat', 'wide_years'],
};

const ROUTER_TIMEOUT_MS = Number(process.env.LLM_ROUTER_TIMEOUT_MS || 15000);
const LLM_WIN_CONFIDENCE = 0.85;

function classifierFallbackScenario(structurePack) {
    const fromOntology = resolveScenarioFromOntology(structurePack.ontology);
    if (fromOntology) return fromOntology;

    const structureId =
        structurePack.structure_id ||
        structurePack.ontology?.suggested_structure_id ||
        structurePack.classifier_ranked?.[0]?.structure_id;
    if (!structureId) return null;
    return (
        structureIdToScenarioId({ structure_id: structureId }) ||
        STRUCTURE_TO_SCENARIO[structureId] ||
        structurePack.ontology?.suggested_scenario ||
        null
    );
}

function normalizeRouterResponse(raw, structurePack) {
    let scenarioId = String(raw?.scenarioId || '').trim();
    if (!ROUTER_ALLOWED_IDS.includes(scenarioId)) {
        scenarioId = classifierFallbackScenario(structurePack) || 'custom_rule';
    }
    const confidence = Math.min(1, Math.max(0, Number(raw?.confidence) || 0.5));
    return {
        scenarioId,
        confidence,
        structureOntology: raw?.structureOntology || {
            layout_type: structurePack.ontology?.layout_type,
            row_pattern: structurePack.ontology?.row_pattern,
            has_tree: structurePack.ontology?.has_tree,
        },
        reasoning: String(raw?.reasoning || '').slice(0, 500),
        fallback: raw?.fallback || (scenarioId === 'custom_rule' ? 'bootstrap' : null),
        source: 'llm',
    };
}

/** Высокая уверенность classifier — не ждём LLM-router (экономим 15–120+ сек на лист). */
function shouldSkipLlmRouter(structure, structurePack) {
    const sid = structure?.structure_id;
    if (!sid || sid === 'unknown' || sid === 'instruction') return false;
    if (!structure?.autoParse) return false;
    const conf = Math.max(
        Number(structure.confidence) || 0,
        Number(structurePack?.classifier_ranked?.[0]?.confidence) || 0
    );
    if (conf < 0.85) return false;
    return Boolean(classifierFallbackScenario(structurePack));
}

function reconcileWithClassifier(routerResult, structurePack) {
    const classifierScenario = classifierFallbackScenario(structurePack);
    if (!classifierScenario || classifierScenario === routerResult.scenarioId) {
        return { ...routerResult, classifierScenario };
    }
    const top = structurePack.classifier_ranked?.[0];
    const classifierConf = top?.confidence || 0;
    const structureId =
        structurePack.structure_id || top?.structure_id || structurePack.ontology?.suggested_structure_id;
    const disagree = routerResult.scenarioId !== classifierScenario;
    const trace = {
        llm: routerResult.scenarioId,
        classifier: classifierScenario,
        llmConfidence: routerResult.confidence,
        classifierConfidence: classifierConf,
        disagree,
    };

    const primary = structureIdToScenarioId({ structure_id: structureId });
    const allowed = ALLOWED_SCENARIOS[structureId] || (primary ? [primary] : []);
    const routerAllowed = !allowed.length || allowed.includes(routerResult.scenarioId);
    const classifierAllowed = !allowed.length || allowed.includes(classifierScenario);

    if (
        disagree &&
        classifierConf >= 0.85 &&
        classifierAllowed &&
        (!routerAllowed || routerResult.source === 'cache')
    ) {
        return {
            ...routerResult,
            scenarioId: classifierScenario,
            source: routerAllowed ? 'classifier_override' : 'classifier_structure_mismatch',
            reasoning: `${routerResult.reasoning} [classifier: ${classifierScenario} вместо ${routerResult.scenarioId}]`,
            reconcileTrace: trace,
        };
    }

    if (disagree && routerResult.confidence < LLM_WIN_CONFIDENCE && classifierConf >= routerResult.confidence) {
        return {
            ...routerResult,
            scenarioId: classifierScenario,
            source: 'classifier_override',
            reasoning: `${routerResult.reasoning} [classifier override: ${classifierScenario}]`,
            reconcileTrace: trace,
        };
    }
    return { ...routerResult, reconcileTrace: trace, classifierScenario };
}

/**
 * @param {object} structurePack
 * @param {{ userMessage?: string, skipCache?: boolean, skipLlm?: boolean }} opts
 */
async function resolveScenarioWithLlm(structurePack, opts = {}) {
    if (!isLlmRouterEnabled()) {
        const scenarioId = classifierFallbackScenario(structurePack);
        return {
            scenarioId,
            confidence: structurePack.classifier_ranked?.[0]?.confidence || 0.5,
            source: 'classifier_only',
            reasoning: 'MARTIN_LLM_ROUTER отключён',
            fallback: null,
        };
    }

    const fingerprint = structurePack.fingerprint;
    if (!opts.skipCache && fingerprint) {
        const cached = getCachedScenario(fingerprint);
        if (cached?.scenarioId) {
            const cachedResult = {
                scenarioId: cached.scenarioId,
                confidence: cached.confidence || 0.9,
                structureOntology: cached.structureOntology,
                reasoning: cached.reasoning || 'cache hit',
                fallback: cached.fallback || null,
                source: 'cache',
            };
            return reconcileWithClassifier(cachedResult, structurePack);
        }
    }

    if (opts.skipLlm) {
        const scenarioId = classifierFallbackScenario(structurePack);
        return {
            scenarioId,
            confidence: structurePack.classifier_ranked?.[0]?.confidence || 0.5,
            source: 'classifier_fallback',
            reasoning: 'LLM пропущен (skipLlm)',
            fallback: null,
        };
    }

    const classifierScenario = classifierFallbackScenario(structurePack);

    try {
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: SCENARIO_ROUTER_SYSTEM },
                { role: 'user', content: buildScenarioRouterUserPrompt(structurePack) },
            ],
            temperature: 0.1,
            responseFormat: { type: 'json_object' },
        });

        const raw = extractJsonFromLlmContent(content);
        const normalized = normalizeRouterResponse(raw, structurePack);
        return reconcileWithClassifier(normalized, structurePack);
    } catch (err) {
        return {
            scenarioId: classifierScenario || 'custom_rule',
            confidence: structurePack.classifier_ranked?.[0]?.confidence || 0.4,
            source: 'classifier_fallback',
            reasoning: `LLM router error: ${err.message}`,
            fallback: classifierScenario ? null : 'bootstrap',
            error: err.message,
        };
    }
}

function cacheValidatedScenario(fingerprint, routerResult) {
    if (!fingerprint || !routerResult?.scenarioId || routerResult.scenarioId === 'custom_rule') {
        return null;
    }
    return setCachedScenario(fingerprint, {
        scenarioId: routerResult.scenarioId,
        confidence: routerResult.confidence,
        structureOntology: routerResult.structureOntology,
        reasoning: routerResult.reasoning,
        fallback: routerResult.fallback,
    });
}

module.exports = {
    ROUTER_ALLOWED_IDS,
    LLM_WIN_CONFIDENCE,
    resolveScenarioWithLlm,
    classifierFallbackScenario,
    shouldSkipLlmRouter,
    normalizeRouterResponse,
    reconcileWithClassifier,
    cacheValidatedScenario,
};
