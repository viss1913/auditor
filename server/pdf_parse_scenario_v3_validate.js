const { safeRegex } = require('./universal_parse/extraction_rule_v1_validate');

const ENGINES = ['pdfjs_grid', 'regex_rows', 'line_anchors'];

function isV3Rule(rule) {
    return rule && Number(rule.rule_schema_version) === 3;
}

function validatePdfParseScenarioV3(rule) {
    const errors = [];
    if (!rule || typeof rule !== 'object') {
        return { ok: false, errors: ['Правило должно быть объектом JSON'] };
    }
    if (Number(rule.rule_schema_version) !== 3) {
        return { ok: false, errors: ['rule_schema_version должен быть 3'] };
    }

    const meta = rule.meta;
    if (!meta?.name || typeof meta.name !== 'string') {
        errors.push('meta.name обязателен');
    }
    if (meta?.source_type !== 'pdf') {
        errors.push('meta.source_type должен быть pdf');
    }

    const layout = rule.layout;
    if (!layout || typeof layout !== 'object') {
        errors.push('layout обязателен');
    } else if (!ENGINES.includes(layout.engine)) {
        errors.push(`layout.engine: одно из ${ENGINES.join(', ')}`);
    }

    for (const key of ['section_start', 'section_end']) {
        const anchor = layout?.[key];
        if (anchor?.pattern) {
            const chk = safeRegex(anchor.pattern);
            if (!chk.ok) errors.push(`layout.${key}: ${chk.error}`);
        }
    }

    if (!Array.isArray(rule.columns) || rule.columns.length === 0) {
        errors.push('columns: нужен непустой массив');
    } else {
        rule.columns.forEach((col, i) => {
            if (!col.target) errors.push(`columns[${i}].target обязателен`);
            if (typeof col.center_norm !== 'number' || col.center_norm < 0 || col.center_norm > 1) {
                errors.push(`columns[${i}].center_norm должен быть 0..1`);
            }
        });
    }

    if (errors.length) return { ok: false, errors };
    return { ok: true, rule };
}

module.exports = { isV3Rule, validatePdfParseScenarioV3, ENGINES };
