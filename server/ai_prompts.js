const path = require('path');
const fs = require('fs');

const EXAMPLES_DIR = path.join(__dirname, 'rules', 'examples');

function loadExample(name) {
    return JSON.parse(fs.readFileSync(path.join(EXAMPLES_DIR, name), 'utf8'));
}

/** profileFamily: os | uk — какой few-shot ближе к задаче */
function getV2SystemPrompt(profileFamily, options = {}) {
    const exOs = loadExample('os_hierarchy_01.json');
    const exUk = loadExample('uk_card.json');
    const layoutNote = options.layoutHint
        ? `\nРекомендованный layout из analyze-layout: ${JSON.stringify(options.layoutHint)}`
        : '';

    const catalogNote = options.columnCatalog
        ? `\nВ контексте есть column_catalog: для каждой метрики используй ТОЛЬКО suggested_measure (cost_open, residual_close, …) в columns[].source.measure. НЕ указывай index/letter колонок Excel в правиле — это знает движок.

Иерархия в колонке A — это path (массив предков), не отдельные колонки Excel. В hierarchy_tree_sample видно: path: ["Здания", "РТК Волгоград", "ОП АБГ-…"], leaf_name — имя ОС.
Для columns используй hierarchy_field: group → path[0], unit → path[1] (КЦ/РТК), subdivision → последний уровень path (ОП), parent_unit → предпоследний (РТК для ОП), asset_name → leaf_name, path → "A / B / C" строкой.`
        : '';

    const primary = profileFamily === 'uk' ? exUk : exOs;
    const secondary = profileFamily === 'uk' ? exOs : exUk;

    return `Ты помогаешь аудитору собрать ParsingRule v2 для универсального движка Excel.

ВАЖНО:
- Ты НЕ пишешь код и НЕ используешь старый формат (variant, output_metrics, source: os_excel).
- Только JSON с rule_schema_version: 2.
- Колонки Excel (A, B, индексы) НЕ задаёшь — только source.measure из column_catalog.suggested_measure.
- target колонки — человекочитаемые подписи (можно из header_path + год).

Структура:
- rule_schema_version: 2
- meta: { name, source_type: "excel", sheet_name, profile_hint }
- layout.layout_type: hierarchy_rows | wide_metrics | fixed_columns | hierarchy_osv
- layout.name_column — только 0 или 1; для типовой 1С ведомости ОС обычно 0 (колонка A = имя)
- hierarchy.leaf_rules — для иерархии 1С
- hierarchy.levels[] — опционально: group/unit/branch patterns (дефолт os_hierarchy_3level)
- columns[]: { target, source: { type, measure?, field? } }
- filters.skip_row_patterns
- output: { shape: "wide"|"long" }

Допустимые source.type: hierarchy_field, metric, entity_from_header, fixed_cell, osv_turnover

Метрики measure (ведомость ОС): cost_open, residual_open, amort_charge, residual_close, cost_close, amort_open, …

Основной пример (${profileFamily === 'uk' ? 'УК' : 'ОС'}):
${JSON.stringify(primary, null, 0)}

Доп. пример:
${JSON.stringify(secondary, null, 0)}
${layoutNote}${catalogNote}

Ответ — ТОЛЬКО валидный JSON без markdown.`;
}

function getSystemPrompt(profileFamily, options = {}) {
    return getV2SystemPrompt(profileFamily || 'os', options);
}

module.exports = {
    getV2SystemPrompt,
    getSystemPrompt,
    loadExample,
};
