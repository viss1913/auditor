/**
 * Контракт JSON-правила для smartParseOS (ведомость 01 / ОСВ 08).
 */

const VARIANTS = new Set(['01_depreciation', '01_flat', '08_osv']);

function validateOsRuleJson(rule) {
    const errors = [];

    if (rule === null || rule === undefined) {
        return { ok: false, errors: ['Правило пустое'] };
    }
    if (typeof rule !== 'object' || Array.isArray(rule)) {
        return { ok: false, errors: ['Правило должно быть объектом JSON'] };
    }

    if (!rule.variant || !VARIANTS.has(rule.variant)) {
        errors.push(`variant обязателен: ${[...VARIANTS].join(' | ')}`);
    }

    const cond = rule.conditions;
    if (cond !== undefined && cond !== null) {
        if (typeof cond !== 'object' || Array.isArray(cond)) {
            errors.push('conditions должен быть объектом');
        } else if (cond.sheet_name !== undefined && typeof cond.sheet_name !== 'string') {
            errors.push('conditions.sheet_name должен быть строкой');
        }
    }

    if (rule.source_label !== undefined && typeof rule.source_label !== 'string') {
        errors.push('source_label должен быть строкой');
    }

    if (rule.output_metrics !== undefined && rule.output_metrics !== null) {
        if (!Array.isArray(rule.output_metrics)) {
            errors.push('output_metrics должен быть массивом');
        } else if (rule.output_metrics.length === 0) {
            errors.push('output_metrics не должен быть пустым');
        } else {
            const allowed = new Set([
                'cost_open',
                'amort_open',
                'residual_open',
                'cost_increase',
                'amort_charge',
                'cost_decrease',
                'amort_writeoff',
                'cost_close',
                'amort_close',
                'residual_close',
            ]);
            for (const item of rule.output_metrics) {
                const field = typeof item === 'string' ? item : item?.field;
                if (!field || !allowed.has(field)) {
                    errors.push(`output_metrics: неизвестное поле "${field}"`);
                }
            }
        }
    }

    if (errors.length) {
        return { ok: false, errors };
    }

    return { ok: true, rule };
}

module.exports = { validateOsRuleJson, VARIANTS };
