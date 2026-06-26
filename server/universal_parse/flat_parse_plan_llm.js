/**
 * LLM flat-plan: classifier + ontology + probe + снимок листа → ParsingRule v2 (плоская таблица).
 * Движок parse_engine / tree_walker исполняет правило на всех строках файла.
 */
const { chatCompletion, extractJsonFromLlmContent } = require('../llm_client');
const { validateParsingRuleV2 } = require('../parsing_rule_v2_validate');
const { getV2SystemPrompt } = require('../ai_prompts');
const { getCachedRule, setCachedRule } = require('./rule_cache');
const { buildExcelStructurePack } = require('./structure_pack');
const { isFlatParseLlmEnabled, flatParseLlmMode } = require('../martin_flags');
const {
    probeNeedsFlatParseRefinement,
    previewFailsFlatSanity,
    scenarioUsesFlatParseEngine,
} = require('../flat_parse_sanity');

const FLAT_INTENT_DEFAULT =
    'Сформулируй ParsingRule v2 для перевода листа в плоскую таблицу (одна логическая запись = одна строка).';

const FLAT_PARSE_SYSTEM = `Ты архитектор ParsingRule v2 для аудиторского Excel-парсера.

Задача аудитора: перевести лист Excel в ПЛОСКУЮ таблицу (long/wide строки данных, без потери смысла).

Вход: structure context (classifier, ontology, probe, preview строк). Probe — ГИПОТЕЗА, можно и нужно исправлять.

Типы layout:
1) fixed_columns + row_pattern=bu_kol_pairs (карточка 58, журнал с БУ/Кол.):
   - multi_row: indicator_value="Кол.", склей БУ+Кол. в одну строку
   - column_map: period, document, analytics (ценная бумага, НЕ текст сделки), amount, quantity, debit_account, credit_account
   - amount — сумма в строке БУ; quantity — в следующей строке Кол.
   - НЕ путай amount (суммы сделок) со счётом кредита (76.07.2, 91.01.10)
   - Если col рядом с document содержит тот же текст «Сделка с ц/б» — это merge-дубль, analytics обычно правее (Мечел, рег.номер)

2) hierarchy_rows / hierarchy_osv (дерево ОС, карточка 76):
   - layout_type: hierarchy_rows или hierarchy_osv
   - hierarchy.leaf_rules, hierarchy.levels — развернуть дерево в колонки предков + лист
   - columns: hierarchy_field (group, unit, subdivision, asset_name, …) + metric
   - output.shape: "long" или "wide" по column_catalog

3) wide_metrics (годы в шапке):
   - layout_type: wide_metrics, columns с source.type=metric

Правила ответа:
- Только JSON ParsingRule v2 (rule_schema_version: 2)
- НЕ возвращай parsed rows и суммы
- meta.source_type = "excel"
- meta.sheet_name из контекста
- output.shape = "long" для журналов с bu_kol; для ОС допустимо "wide"

Ответ:
{
  "rule_schema_version": 2,
  "meta": { ... },
  "layout": { ... },
  "column_map": { ... },
  "multi_row": { ... },
  "columns": [ ... ],
  "output": { "shape": "long" },
  "reasoning": "кратко",
  "confidence": 0.0-1.0
}`;

function profileFamilyFromContext(flatContext) {
    const pattern = flatContext?.ontology?.row_pattern;
    const scenario = flatContext?.scenarioId || flatContext?.ontology?.suggested_scenario;
    if (pattern === 'bu_kol_pairs' || scenario === 'uk_card') return 'uk';
    return 'os';
}

/**
 * @param {{
 *   layoutMeta: object,
 *   data: Array,
 *   structure: object,
 *   sheetMeta?: object,
 *   file?: object,
 *   scenarioId?: string,
 *   userMessage?: string,
 *   flatIntent?: string,
 * }} ctx
 */
function buildFlatParseContext(ctx) {
    const {
        userMessage = '',
        flatIntent = FLAT_INTENT_DEFAULT,
        scenarioId = null,
    } = ctx;

    const structurePack =
        ctx.structurePack ||
        buildExcelStructurePack(
            {
                layoutMeta: ctx.layoutMeta,
                data: ctx.data,
                structure: ctx.structure,
                sheetMeta: ctx.sheetMeta,
                file: ctx.file,
            },
            { userMessage }
        );

    const ontology = structurePack.ontology || {};
    const top = structurePack.classifier_ranked?.[0] || {};

    return {
        task: 'flat_long_table',
        flatIntent,
        userMessage,
        scenarioId: scenarioId || structurePack.suggested_scenario || top.structure_id,
        fileName: structurePack.fileName,
        sheetName: structurePack.sheetName,
        structure_id: structurePack.structure_id || top.structure_id,
        classifier: {
            top: top.structure_id,
            confidence: top.confidence,
            ranked: (structurePack.classifier_ranked || []).slice(0, 5),
        },
        ontology: {
            layout_type: ontology.layout_type,
            row_pattern: ontology.row_pattern,
            has_tree: ontology.has_tree,
            suggested_scenario: ontology.suggested_scenario,
            parser_rule: ontology.parser_rule || null,
            account_signals: ontology.account_signals || null,
            balance_signals: ontology.balance_signals || null,
        },
        tree_inference: ctx.layoutMeta?.tree_inference
            ? {
                  profileId: ctx.layoutMeta.tree_inference.profileId,
                  levelLabels: ctx.layoutMeta.tree_inference.levelLabels,
                  examples: (ctx.layoutMeta.tree_inference.examples || []).slice(0, 4),
              }
            : null,
        column_catalog: structurePack.columnCatalog || null,
        probe_hypothesis: structurePack.uk_probe
            ? {
                  skip_rows: structurePack.uk_probe.skip_rows,
                  period_column: structurePack.uk_probe.period_column,
                  document_column: structurePack.uk_probe.document_column,
                  analytics_column: structurePack.uk_probe.analytics_column,
                  indicator_column: structurePack.uk_probe.indicator_column,
                  debit_account_column: structurePack.uk_probe.debit_account_column,
                  amount_column: structurePack.uk_probe.amount_column,
                  credit_account_column: structurePack.uk_probe.credit_account_column,
                  quantity_column: structurePack.uk_probe.quantity_column,
                  balance_column: structurePack.uk_probe.balance_column,
                  quantity_ambiguous: structurePack.uk_probe.quantity_ambiguous,
                  preview_rows: structurePack.uk_probe.preview_rows,
              }
            : null,
        merged_ranges_count:
            ctx.sheetMeta?.mergedRanges?.length ?? ctx.layoutMeta?.merged_ranges?.length ?? 0,
        preview_rows: structurePack.preview_rows,
        preview_header: (ctx.data || []).slice(0, 12).map((row, i) => ({
            row: i,
            cells: (row || []).slice(0, 16).map((c) => String(c ?? '').slice(0, 60)),
        })),
    };
}

function buildFlatParseHints(flatContext) {
    const hints = [];
    if (flatContext.merged_ranges_count > 15) {
        hints.push(
            'Много merged ячеек: колонка после document может быть дублем документа, не аналитикой.'
        );
    }
    if (flatContext.ontology?.row_pattern === 'bu_kol_pairs') {
        hints.push('Пары БУ/Кол. — обязателен multi_row с indicator_value="Кол.".');
    }
    const p = flatContext.probe_hypothesis;
    if (p?.amount_column === p?.credit_account_column) {
        hints.push('probe перепутал amount и credit_account — разведи column_map.');
    }
    if (flatContext.tree_inference?.levelLabels?.length) {
        hints.push(
            `Дерево: уровни ${flatContext.tree_inference.levelLabels.join(' → ')} — разверни в hierarchy_field колонки.`
        );
    }
    return hints;
}

function buildFlatParseUserPrompt(flatContext, baseRule) {
    const hints = buildFlatParseHints(flatContext);
    return `${flatContext.flatIntent}

${flatContext.userMessage ? `Сообщение аудитора: «${flatContext.userMessage}»\n` : ''}
Сценарий (целевой): ${flatContext.scenarioId || 'auto'}

Подсказки:
${hints.map((h) => `- ${h}`).join('\n') || '- нет'}

Structure context:
${JSON.stringify(flatContext, null, 2)}

${baseRule ? `Базовое правило (доработай для плоской таблицы):\n${JSON.stringify(baseRule, null, 2)}\n` : ''}

Верни полное ParsingRule v2.`;
}

function shouldInvokeFlatParseLlm(ctx, scenarioId, baseRule, preview = null) {
    if (!isFlatParseLlmEnabled()) return false;
    if (!scenarioUsesFlatParseEngine(scenarioId)) return false;

    const mode = flatParseLlmMode();
    if (mode === 'off') return false;

    const fp = ctx.structurePack?.fingerprint || ctx.layoutMeta?.layout_fingerprint;
    if (fp && getCachedRule(fp, scenarioId)) return false;

    if (mode === 'always') return true;

    const osPresetScenarios = new Set([
        'os_01_hierarchy',
        'os_01_flat',
        'os_01_cost_only',
        'wide_metrics',
        'os_08_osv',
        'os_76_account_card',
    ]);
    if (osPresetScenarios.has(scenarioId) && preview?.ok && preview.rowCount > 0) {
        if (!previewFailsFlatSanity(scenarioId, preview, ctx.layoutMeta)) return false;
    }

    if (
        scenarioId === 'uk_card' &&
        ctx.structure?.structure_id === 'uk_journal_58' &&
        preview?.ok &&
        preview.rowCount > 0 &&
        !previewFailsFlatSanity(scenarioId, preview, ctx.layoutMeta)
    ) {
        return false;
    }

    if (probeNeedsFlatParseRefinement(ctx.layoutMeta, ctx.layoutMeta?.ontology)) return true;
    if (preview && previewFailsFlatSanity(scenarioId, preview, ctx.layoutMeta)) return true;

    return false;
}

function mergeRuleMeta(rule, baseRule, ctx, scenarioId) {
    const out = { ...rule };
    out.meta = { ...(baseRule?.meta || {}), ...(out.meta || {}) };
    out.meta.source_type = 'excel';
    if (ctx.layoutMeta?.sheetName) out.meta.sheet_name = ctx.layoutMeta.sheetName;
    if (scenarioId) out.meta.profile_hint = out.meta.profile_hint || scenarioId;
    if (!out.output) out.output = {};
    if (out.layout?.layout_type === 'fixed_columns' && out.meta.profile_hint === 'uk_card') {
        out.output.shape = 'long';
    }
    return out;
}

/**
 * @param {{
 *   ctx: object,
 *   scenarioId: string,
 *   baseRule: object,
 *   userMessage?: string,
 *   flatIntent?: string,
 *   force?: boolean,
 * }} opts
 */
async function synthesizeFlatParseRuleWithLlm(opts) {
    const { ctx, scenarioId, baseRule, userMessage = '', flatIntent, force = false } = opts;
    const flatContext = buildFlatParseContext({ ...ctx, scenarioId, userMessage, flatIntent });

    const family = profileFamilyFromContext(flatContext);
    const systemPrompt = `${FLAT_PARSE_SYSTEM}\n\n${getV2SystemPrompt(family, {
        layoutHint: ctx.layoutMeta?.recommended,
        columnCatalog: ctx.layoutMeta?.column_catalog,
    })}`;

    const userPrompt = buildFlatParseUserPrompt(flatContext, baseRule);

    try {
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.1,
            responseFormat: { type: 'json_object' },
        });

        const raw = extractJsonFromLlmContent(content);
        const { reasoning, confidence, ...ruleBody } = raw;
        let rule = mergeRuleMeta(ruleBody, baseRule, ctx, scenarioId);

        const validated = validateParsingRuleV2(rule);
        if (!validated.ok) {
            return {
                ok: false,
                errors: validated.errors,
                flatContext,
                source: 'llm_flat_plan',
            };
        }

        rule = validated.rule;
        return {
            ok: true,
            rule,
            reasoning: String(reasoning || '').slice(0, 500),
            confidence: Math.min(1, Math.max(0, Number(confidence) || 0.5)),
            flatContext,
            source: 'llm_flat_plan',
        };
    } catch (err) {
        return { ok: false, errors: [err.message], flatContext, source: 'llm_flat_plan' };
    }
}

/**
 * Главная точка входа: базовое правило → (опционально) LLM → итоговое правило.
 * Кэширует по fingerprint + scenarioId.
 *
 * @param {{
 *   ctx: object,
 *   scenarioId: string,
 *   baseRule: object,
 *   userMessage?: string,
 *   preview?: object,
 *   force?: boolean,
 * }} opts
 */
function isCachedRuleCompatible(rule, scenarioId) {
    if (!rule?.layout?.layout_type) return true;
    if (scenarioId === 'os_08_osv' || scenarioId === 'os_76_account_card') {
        return rule.layout.layout_type === 'hierarchy_osv';
    }
    if (scenarioId === 'os_01_hierarchy' || scenarioId === 'os_01_flat' || scenarioId === 'os_01_cost_only') {
        return rule.layout.layout_type === 'hierarchy_rows';
    }
    if (scenarioId === 'wide_metrics') {
        return rule.layout.layout_type === 'wide_metrics';
    }
    if (scenarioId === 'uk_card') {
        return rule.layout.layout_type === 'fixed_columns';
    }
    return true;
}

async function refineRuleForFlatTable(opts) {
    const { ctx, scenarioId, baseRule, userMessage = '', preview = null, force = false } = opts;

    if (!baseRule) {
        return { ok: false, rule: null, source: 'none', errors: ['no base rule'] };
    }

    const fp = ctx.structurePack?.fingerprint || ctx.layoutMeta?.layout_fingerprint;
    if (fp) {
        const cached = getCachedRule(fp, scenarioId);
        if (cached && isCachedRuleCompatible(cached, scenarioId)) {
            return { ok: true, rule: cached, source: 'cache', cached: true };
        }
    }

    if (!force && !shouldInvokeFlatParseLlm(ctx, scenarioId, baseRule, preview)) {
        return { ok: true, rule: baseRule, source: 'base', skipped: true };
    }

    const planned = await synthesizeFlatParseRuleWithLlm({
        ctx,
        scenarioId,
        baseRule,
        userMessage: userMessage || FLAT_INTENT_DEFAULT,
        force,
    });

    if (!planned.ok || !planned.rule) {
        return {
            ok: true,
            rule: baseRule,
            source: 'base_fallback',
            errors: planned.errors,
            skipped: false,
        };
    }

    if (!isCachedRuleCompatible(planned.rule, scenarioId)) {
        return {
            ok: true,
            rule: baseRule,
            source: 'base_fallback',
            errors: ['llm rule incompatible with scenario layout'],
            skipped: false,
        };
    }

    if (fp) {
        setCachedRule(fp, planned.rule, scenarioId);
    }

    return {
        ok: true,
        rule: planned.rule,
        source: planned.source,
        reasoning: planned.reasoning,
        confidence: planned.confidence,
        flatContext: planned.flatContext,
    };
}

module.exports = {
    FLAT_INTENT_DEFAULT,
    FLAT_PARSE_SYSTEM,
    buildFlatParseContext,
    buildFlatParseUserPrompt,
    shouldInvokeFlatParseLlm,
    synthesizeFlatParseRuleWithLlm,
    refineRuleForFlatTable,
};
