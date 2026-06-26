const { chatCompletion, extractJsonFromLlmContent } = require('../llm_client');
const { bootstrapRuleWithLlm } = require('../rule_bootstrap_llm');
const { validateExtractionRuleV1 } = require('./extraction_rule_v1_validate');
const { structurePackForLlm } = require('./structure_pack');
const { executePdfExtractionRule } = require('./pdf_rule_engine');
const { parseRequestedTableColumns } = require('../document_scan_llm');

const EXTRACTION_SYSTEM = `Ты архитектор правил извлечения данных. Верни JSON ExtractionRule v1.
НЕ пиши JavaScript. rule_schema_version=1.
meta.source_type: pdf|excel|text.
Для PDF УПД Эдивеб: profile_hint=upd_ediweb, tables[{id:"line_items",row_mode:"state_machine"}].
Для брокерских отчётов (Атон и аналоги): profile_hint=broker_pdf, вложенные шапки таблиц, извлекай колонки из запроса пользователя.
Для неизвестного PDF: anchors + tables с regex_rows.`;

/**
 * @param {{ structurePack: object, userMessage?: string, layoutMeta?: object }} opts
 */
async function synthExtractionRuleWithLlm({ structurePack, userMessage = '', layoutMeta = null }) {
    if (structurePack.sourceKind === 'excel' && layoutMeta) {
        const excel = await bootstrapRuleWithLlm({
            layoutMeta,
            userMessage: userMessage || 'Собери правило парсинга для этого файла',
        });
        if (excel.ok) {
            return { ok: true, rule: excel.rule, ruleType: 'parsing_rule_v2', source: 'llm' };
        }
        return { ok: false, errors: excel.errors, rule: null };
    }

    const packJson = structurePackForLlm(structurePack);
    const requestedColumns = parseRequestedTableColumns(userMessage);
    const columnsHint =
        requestedColumns.length > 0
            ? `\nОбязательные колонки результата: ${requestedColumns.join(', ')}`
            : '';
    const userPrompt = `Structure pack:\n${packJson}\n\nЗапрос: ${userMessage || 'Извлеки основную таблицу данных.'}${columnsHint}`;

    try {
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: EXTRACTION_SYSTEM },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.12,
            responseFormat: { type: 'json_object' },
        });
        const rule = extractJsonFromLlmContent(content);
        const validated = validateExtractionRuleV1(rule);
        if (!validated.ok) {
            return { ok: false, errors: validated.errors, rule: null };
        }
        return { ok: true, rule: validated.rule, ruleType: 'extraction_rule_v1', source: 'llm' };
    } catch (err) {
        return { ok: false, errors: [err.message], rule: null };
    }
}

function executeRule(probeResult, rule) {
    if (rule.rule_schema_version === 2) {
        return { ok: false, errors: ['Use parse_engine for ParsingRule v2'] };
    }
    if (probeResult.sourceKind === 'pdf') {
        return executePdfExtractionRule(probeResult.lines || [], rule);
    }
    return { ok: false, errors: ['Executor not implemented for this source'] };
}

module.exports = { synthExtractionRuleWithLlm, executeRule, EXTRACTION_SYSTEM };
