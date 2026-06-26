const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');
const { getV2SystemPrompt } = require('./ai_prompts');
const { validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const { detectProfile } = require('./orchestrator/session_plan');
const { structurePackForLlm } = require('./universal_parse/structure_pack');

function shouldBootstrapWithLlm(layoutMeta, userMessage, validationFailed = false) {
    if (validationFailed) return true;
    if (!userMessage || !String(userMessage).trim()) return false;
    const profile = detectProfile(layoutMeta);
    if (profile === 'unknown') return true;
    if (/колонк|договор|сумм|структур|layout|счёт|счет/i.test(userMessage)) return true;
    return false;
}

function profileFamilyFromLayout(layoutMeta) {
    const hint = layoutMeta?.recommended?.profile_hint || layoutMeta?.ontology?.suggested_scenario || '';
    if (hint === 'uk_card' || layoutMeta?.ontology?.row_pattern === 'bu_kol_pairs') return 'uk';
    return 'os';
}

function buildBootstrapUserPrompt({ layoutMeta, userMessage, baseRule, structurePack, failedChecks }) {
    const ontology = layoutMeta?.ontology || structurePack?.ontology;
    const packJson = structurePack ? structurePackForLlm(structurePack) : '';
    const checksText = (failedChecks || [])
        .filter((c) => c.status !== 'pass')
        .map((c) => `- ${c.id}: ${c.message || c.detail || c.status}`)
        .join('\n');

    return `Запрос аудитора: «${userMessage || 'Собери правило парсинга для этого листа'}»

Файл: лист «${layoutMeta?.sheetName || '?'}», layout ${ontology?.layout_type || layoutMeta?.recommended?.layout_type || 'unknown'}.
row_pattern: ${ontology?.row_pattern || 'unknown'}
${packJson ? `\nStructure pack:\n${packJson}\n` : ''}
${baseRule ? `Базовое правило (можно доработать):\n${JSON.stringify(baseRule)}\n` : ''}
${checksText ? `Проваленные проверки валидации:\n${checksText}\n` : ''}

Собери ParsingRule v2 под этот файл. Не выдумывай суммы — только структуру колонок.`;
}

/**
 * @param {{ layoutMeta: object, userMessage?: string, baseRule?: object, structurePack?: object, failedChecks?: Array, validationFailed?: boolean }} opts
 */
async function bootstrapRuleWithLlm(opts) {
    const {
        layoutMeta,
        userMessage = '',
        baseRule = null,
        structurePack = null,
        failedChecks = null,
        validationFailed = false,
    } = opts;
    const family = profileFamilyFromLayout(layoutMeta);
    const systemPrompt = getV2SystemPrompt(family, {
        layoutHint: layoutMeta?.recommended,
        columnCatalog: layoutMeta?.column_catalog,
    });

    const userPrompt = buildBootstrapUserPrompt({
        layoutMeta,
        userMessage,
        baseRule,
        structurePack,
        failedChecks,
    });

    try {
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: validationFailed || failedChecks?.length ? 0.12 : 0.15,
            responseFormat: { type: 'json_object' },
        });

        const rule = extractJsonFromLlmContent(content);
        const validated = validateParsingRuleV2(rule);
        if (!validated.ok) {
            return { ok: false, errors: validated.errors, rule: null };
        }
        return { ok: true, rule: validated.rule, source: 'llm' };
    } catch (err) {
        return { ok: false, errors: [err.message], rule: null };
    }
}

/**
 * Один repair pass: патч правила v2 по failed checks.
 * @param {{ baseRule: object, layoutMeta: object, structurePack?: object, failedChecks: Array }} opts
 */
async function repairRuleWithLlm({ baseRule, layoutMeta, structurePack = null, failedChecks = [] }) {
    if (!baseRule || !failedChecks.length) {
        return { ok: false, errors: ['repair: нет базового правила или checks'], rule: null };
    }
    const family = profileFamilyFromLayout(layoutMeta);
    const systemPrompt = `${getV2SystemPrompt(family, {
        layoutHint: layoutMeta?.recommended,
        columnCatalog: layoutMeta?.column_catalog,
    })}

Ты чинишь существующее ParsingRule v2. Верни ПОЛНОЕ исправленное правило JSON, не diff.`;

    const checksText = failedChecks
        .filter((c) => c.status !== 'pass')
        .map((c) => `- ${c.id}: ${c.message || c.detail || ''}`)
        .join('\n');
    const packJson = structurePack ? structurePackForLlm(structurePack) : '';

    const userPrompt = `Правило не прошло валидацию. Исправь минимально.

Failed checks:
${checksText}

Текущее правило:
${JSON.stringify(baseRule)}

${packJson ? `Structure pack:\n${packJson}` : ''}`;

    try {
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.1,
            responseFormat: { type: 'json_object' },
        });
        const rule = extractJsonFromLlmContent(content);
        const validated = validateParsingRuleV2(rule);
        if (!validated.ok) {
            return { ok: false, errors: validated.errors, rule: null };
        }
        return { ok: true, rule: validated.rule, source: 'llm_repair' };
    } catch (err) {
        return { ok: false, errors: [err.message], rule: null };
    }
}

module.exports = {
    bootstrapRuleWithLlm,
    repairRuleWithLlm,
    shouldBootstrapWithLlm,
    buildBootstrapUserPrompt,
};
