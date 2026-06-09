const LAYOUT_TYPES = ['hierarchy_rows', 'wide_metrics', 'fixed_columns', 'hierarchy_osv'];
const SOURCE_TYPES = [
    'hierarchy_field',
    'metric',
    'entity_from_header',
    'fixed_cell',
    'osv_turnover',
    'composite_cell',
];

const HIERARCHY_FIELDS = new Set([
    'group',
    'unit',
    'branch',
    'subdivision',
    'parent_unit',
    'path',
    'asset_name',
    'year',
    'account',
    'object_name',
    'period_label',
    'period_year',
]);

function isV2Rule(rule) {
    return rule && Number(rule.rule_schema_version) === 2;
}

function validateParsingRuleV2(rule) {
    const errors = [];
    if (!rule || typeof rule !== 'object') {
        return { ok: false, errors: ['Правило должно быть объектом JSON'] };
    }
    if (Number(rule.rule_schema_version) !== 2) {
        return { ok: false, errors: ['rule_schema_version должен быть 2'] };
    }

    const meta = rule.meta;
    if (!meta || typeof meta !== 'object') {
        errors.push('meta обязателен');
    } else {
        if (!meta.name || typeof meta.name !== 'string') errors.push('meta.name обязателен');
        if (meta.source_type !== 'excel') errors.push('meta.source_type должен быть excel');
    }

    const layout = rule.layout;
    if (!layout || typeof layout !== 'object') {
        errors.push('layout обязателен');
    } else if (!LAYOUT_TYPES.includes(layout.layout_type)) {
        errors.push(`layout.layout_type: одно из ${LAYOUT_TYPES.join(', ')}`);
    }

    if (!Array.isArray(rule.columns) || rule.columns.length === 0) {
        errors.push('columns: нужен непустой массив');
    } else {
        rule.columns.forEach((col, i) => {
            if (!col.target) errors.push(`columns[${i}].target обязателен`);
            const src = col.source;
            if (!src || !SOURCE_TYPES.includes(src.type)) {
                errors.push(`columns[${i}].source.type недопустим`);
            }
            if (src?.type === 'hierarchy_field' && !src.field) {
                errors.push(`columns[${i}]: hierarchy_field требует field`);
            }
            if (src?.type === 'metric' && !src.measure) {
                errors.push(`columns[${i}]: metric требует measure`);
            }
            if (src?.type === 'composite_cell') {
                if (!Number.isInteger(src.column)) errors.push(`columns[${i}]: composite_cell требует column (integer)`);
                if (!src.extract?.pattern) errors.push(`columns[${i}]: composite_cell требует extract.pattern`);
            }
        });
    }

    if (layout?.layout_type === 'fixed_columns') {
        if (!rule.column_map || typeof rule.column_map !== 'object') {
            errors.push('fixed_columns: нужен column_map');
        }
    }

    if (errors.length) return { ok: false, errors };
    return { ok: true, rule };
}

module.exports = {
    isV2Rule,
    validateParsingRuleV2,
    LAYOUT_TYPES,
    SOURCE_TYPES,
    HIERARCHY_FIELDS,
};
