const { resolveBrokerSectionFromMessage } = require('./broker_section_resolve');
const { resolveParseIntentWithLlm } = require('./parse_intent_llm');

function normalizePrefix(prefix) {
    const p = String(prefix || '').trim();
    if (!p) return null;
    return p.endsWith('_') ? p : `${p}_`;
}

function refineBrokerSection(plan, userMessage) {
    const msg = String(userMessage || '').trim();
    if (!msg) return plan;

    const isBroker =
        plan.scenarioId === 'opif_broker' ||
        /брокер|1f\d{3}|1\.1|1\.2|репо|прекращ|не\s+исполн/i.test(msg);
    if (!isBroker) return plan;

    const resolved = resolveBrokerSectionFromMessage(msg, {
        defaultSection: plan.brokerSection || '1.2',
    });

    const hints = { ...(plan.orchestratorHints || {}) };
    if (!plan.brokerSection || resolved.source !== 'default') {
        plan.brokerSection = resolved.brokerSection;
        hints.brokerSectionSource = resolved.source;
        hints.brokerSectionConfidence = resolved.confidence;
    }
    plan.orchestratorHints = hints;
    return plan;
}

function shouldCallParseIntentLlm(userMessage, plan) {
    if (process.env.MARTIN_PARSE_INTENT_LLM === '0') return false;
    const msg = String(userMessage || '').trim();
    if (msg.length < 4) return false;

    const brokerish =
        plan.scenarioId === 'opif_broker' ||
        /брокер|1f\d{3}|aton|атон|репо|прекращ|не\s*исполн|обязательств/i.test(msg);
    if (!brokerish) return false;

    const src = plan.orchestratorHints?.brokerSectionSource;
    return (
        !plan.scenarioId ||
        !plan.filePrefix ||
        src === 'default' ||
        plan.confidence < 0.9
    );
}

function mergeLlmIntoPlan(plan, llm) {
    if (!llm || llm.confidence < 0.55) return plan;

    const hints = { ...(plan.orchestratorHints || {}) };
    hints.parseIntentLlm = { confidence: llm.confidence, reason: llm.reason };

    if (!plan.scenarioId && llm.scenarioId) {
        plan.scenarioId = llm.scenarioId;
    }
    if (!plan.filePrefix && llm.filePrefix) {
        plan.filePrefix = normalizePrefix(llm.filePrefix);
        plan.fileFilter = { mode: 'prefix', value: plan.filePrefix };
    }

    if (
        llm.brokerSection &&
        (!plan.brokerSection ||
            plan.brokerSection === '1.2' ||
            llm.confidence >= 0.82)
    ) {
        plan.brokerSection = llm.brokerSection;
        hints.brokerSectionSource = 'llm';
        hints.brokerSectionConfidence = llm.confidence;
    }

    if (llm.mergeOneTable === true) {
        plan.mergeMode = 'single_table';
        plan.mergeStrategy = 'one_table';
    }

    if (plan.scenarioId === 'opif_broker') {
        plan.intent = 'parse_batch';
        plan.confidence = Math.max(plan.confidence || 0, llm.confidence);
    }

    plan.orchestratorHints = hints;
    return plan;
}

/**
 * Дорабатывает план: семантика секции брокера + опционально LLM.
 */
async function enrichParsePlan(plan, userMessage, ctx = {}) {
    const p = { ...plan, orchestratorHints: { ...(plan.orchestratorHints || {}) } };
    refineBrokerSection(p, userMessage);

    if (shouldCallParseIntentLlm(userMessage, p)) {
        try {
            const llm = await resolveParseIntentWithLlm(userMessage, ctx.probe || p.probe);
            mergeLlmIntoPlan(p, llm);
        } catch (err) {
            p.orchestratorHints.parseIntentLlmError = String(err.message || err).slice(0, 200);
        }
    }

    refineBrokerSection(p, userMessage);

    if (p.scenarioId === 'opif_broker' && !p.brokerSection) {
        p.brokerSection = resolveBrokerSectionFromMessage(userMessage).brokerSection;
    }

    return p;
}

module.exports = {
    enrichParsePlan,
    refineBrokerSection,
    shouldCallParseIntentLlm,
    mergeLlmIntoPlan,
};
