function isSmartDialogEnabled() {
    return process.env.MARTIN_SMART_DIALOG === '1';
}

function isBrokerLlmProbeEnabled() {
    return process.env.MARTIN_BROKER_LLM_PROBE === '1';
}

function shouldUseLlmReply() {
    return process.env.MARTIN_USE_LLM_AUTOSTART === '1' || isSmartDialogEnabled();
}

/** LLM-router на каждый Excel-лист Martin/inbox. MARTIN_LLM_ROUTER=0 — откат на classifier-only. */
function isLlmRouterEnabled() {
    const v = String(process.env.MARTIN_LLM_ROUTER ?? '1').trim().toLowerCase();
    return v !== '0' && v !== 'false' && v !== 'off';
}

/**
 * LLM flat-plan: structure pack → ParsingRule v2 для плоской таблицы.
 * MARTIN_FLAT_PARSE_LLM: auto (default) | always | off
 * auto — при подозрительном probe, fail sanity, дереве без кэша
 */
function flatParseLlmMode() {
    const v = String(process.env.MARTIN_FLAT_PARSE_LLM ?? 'auto').trim().toLowerCase();
    if (v === '0' || v === 'off' || v === 'false') return 'off';
    if (v === 'always' || v === '1' || v === 'true') return 'always';
    return 'auto';
}

function isFlatParseLlmEnabled() {
    return flatParseLlmMode() !== 'off';
}

module.exports = {
    isSmartDialogEnabled,
    isBrokerLlmProbeEnabled,
    shouldUseLlmReply,
    isLlmRouterEnabled,
    flatParseLlmMode,
    isFlatParseLlmEnabled,
};
