/**
 * Контракт JSON-правила для smartParseUK (см. README, раздел «Умный парсинг УК»).
 * Используются только conditions.* и operation_type; раскладка колонок Excel фиксирована в коде парсера.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDateString(s) {
    if (!ISO_DATE.test(s)) return false;
    const d = new Date(s + 'T12:00:00');
    return !Number.isNaN(d.getTime());
}

/**
 * @param {unknown} rule
 * @returns {{ ok: true, rule: object } | { ok: false, errors: string[] }}
 */
function validateUkRuleJson(rule) {
    const errors = [];

    if (rule === null || rule === undefined) {
        return { ok: false, errors: ['Правило пустое'] };
    }
    if (typeof rule !== 'object' || Array.isArray(rule)) {
        return { ok: false, errors: ['Правило должно быть объектом JSON'] };
    }

    const cond = rule.conditions;
    if (cond !== undefined && cond !== null) {
        if (typeof cond !== 'object' || Array.isArray(cond)) {
            errors.push('conditions должен быть объектом');
        } else {
            for (const key of ['debit_account', 'credit_account']) {
                if (cond[key] !== undefined && cond[key] !== null && typeof cond[key] !== 'string') {
                    errors.push(`conditions.${key} должен быть строкой`);
                }
            }
            for (const key of ['date_start', 'date_end']) {
                const v = cond[key];
                if (v !== undefined && v !== null && v !== '') {
                    if (typeof v !== 'string' || !isValidIsoDateString(v)) {
                        errors.push(`conditions.${key} должен быть датой в формате YYYY-MM-DD`);
                    }
                }
            }
            const ds = cond.date_start;
            const de = cond.date_end;
            if (ds && de && isValidIsoDateString(ds) && isValidIsoDateString(de)) {
                if (new Date(ds) > new Date(de)) {
                    errors.push('conditions.date_start не может быть позже date_end');
                }
            }
        }
    }

    if (rule.operation_type !== undefined && rule.operation_type !== null && typeof rule.operation_type !== 'string') {
        errors.push('operation_type должен быть строкой');
    }

    if (errors.length) {
        return { ok: false, errors };
    }

    return { ok: true, rule };
}

/**
 * Разбор ruleJson из multipart (строка JSON).
 * @param {string|null|undefined} raw
 * @returns {{ ok: true, rule: object } | { ok: false, errors: string[] }}
 */
function parseAndValidateUkRuleJsonString(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { ok: false, errors: ['ruleJson не передан'] };
    }
    let parsed;
    try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
        return { ok: false, errors: ['ruleJson не является корректным JSON: ' + (e.message || String(e))] };
    }
    return validateUkRuleJson(parsed);
}

module.exports = {
    validateUkRuleJson,
    parseAndValidateUkRuleJsonString,
    isValidIsoDateString,
};
