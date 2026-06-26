/**
 * Промпты LLM-router: выбор scenarioId по structure pack (онтология, не имена колонок).
 */

const ROUTER_ALLOWED_IDS = [
    'uk_card',
    'uk_osv_58',
    'ks_card_composite_raw',
    'ks_card_flat',
    'os_76_account_card',
    'os_08_osv',
    'os_01_hierarchy',
    'os_01_flat',
    'os_01_cost_only',
    'wide_metrics',
    'from_target',
    'revenue_osv_90',
    'revenue_period',
    'osv_flat_processed',
    'custom_rule',
];

const SCENARIO_ROUTER_SYSTEM = `Ты маршрутизатор сценариев парсинга Excel для аудита.
Выбирай scenarioId ТОЛЬКО из закрытого списка. Не возвращай parsed rows, индексы колонок и суммы.

Закрытый список scenarioId:
${ROUTER_ALLOWED_IDS.join(', ')}

Ключевые признаки по онтологии (не по названиям колонок в шапке):
- uk_card: row_pattern=bu_kol_pairs, account_signals.bu58>=2, даты в col A, пары строк БУ+Кол. со счётом 58.01, часто balance_signals.has_balance_pairs (Текущее сальдо на БУ и Кол.)
- ks_card_composite_raw: row_pattern=journal_dt_kt, journal_signals.debit_credit_cols=true, НЕТ bu_kol_pairs с bu58>=2
- uk_osv_58: row_pattern=wide_bu_kol_columns, has_tree=true, layout_type=hierarchy_rows
- os_76_account_card: layout_type=hierarchy_osv, account_signals.contract_labels и counterparty_labels
- os_08_osv: счета 08* в col A, дерево
- hierarchy_os_01 / os_01_hierarchy: дерево периодов, инв.номера, НЕ журнал 1С
- wide_metrics: layout_type=wide_metrics, годы в шапке
- revenue_osv_90 / revenue_period: account_signals.account90, блок периодов
- osv_flat_processed: flat_dimensions, плоская обработанная ОСВ
- custom_rule: ни один сценарий не подходит → scenarioId=custom_rule, fallback=bootstrap

Few-shot:
1) ontology.row_pattern=bu_kol_pairs, bu58=5, parser_rule.scenarioId=uk_card → uk_card (НЕ ks_card_composite_raw)
2) ontology.row_pattern=journal_dt_kt, bu58=0 → ks_card_composite_raw
3) ontology.row_pattern=wide_bu_kol_columns, has_tree=true → uk_osv_58
4) ontology.suggested_scenario=uk_card и classifier_ranked[0]=journal_1c → всё равно uk_card

Ответ — JSON:
{
  "scenarioId": "...",
  "confidence": 0.0-1.0,
  "structureOntology": { "layout_type": "...", "row_pattern": "...", "has_tree": false },
  "reasoning": "кратко",
  "fallback": null
}
Если custom_rule: "fallback": "bootstrap"`;

function buildScenarioRouterUserPrompt(structurePack) {
    const pack = {
        fileName: structurePack.fileName,
        sheetName: structurePack.sheetName,
        fingerprint: structurePack.fingerprint,
        ontology: structurePack.ontology,
        classifier_ranked: structurePack.classifier_ranked,
        uk_probe: structurePack.uk_probe,
        scenario_catalog: structurePack.scenario_catalog,
        preview_rows: structurePack.preview_rows,
        userMessage: structurePack.userMessage || '',
    };
    return `Structure pack:\n${JSON.stringify(pack, null, 2)}\n\nВыбери scenarioId.`;
}

module.exports = {
    ROUTER_ALLOWED_IDS,
    SCENARIO_ROUTER_SYSTEM,
    buildScenarioRouterUserPrompt,
};
