const MAX_PATTERN_LEN = 200;
const FORBIDDEN = /eval|Function|require|import\s|process\.|child_process/i;

function safeRegex(pattern) {
    if (!pattern || typeof pattern !== 'string') return { ok: false, error: 'pattern required' };
    if (pattern.length > MAX_PATTERN_LEN) return { ok: false, error: 'pattern too long' };
    if (FORBIDDEN.test(pattern)) return { ok: false, error: 'forbidden pattern' };
    try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
        return { ok: true };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function validateExtractionRuleV1(rule) {
    const errors = [];
    if (!rule || typeof rule !== 'object') {
        return { ok: false, errors: ['rule must be object'] };
    }
    if (Number(rule.rule_schema_version) !== 1) {
        errors.push('rule_schema_version must be 1');
    }
    const meta = rule.meta;
    if (!meta?.name) errors.push('meta.name required');
    if (!['pdf', 'excel', 'text'].includes(meta?.source_type)) {
        errors.push('meta.source_type must be pdf|excel|text');
    }

    for (const [key, anchor] of Object.entries(rule.anchors || {})) {
        if (anchor.pattern) {
            const chk = safeRegex(anchor.pattern);
            if (!chk.ok) errors.push(`anchors.${key}: ${chk.error}`);
        }
    }

    for (const table of rule.tables || []) {
        if (!table.id) errors.push('table.id required');
        if (!['state_machine', 'regex_rows', 'grid'].includes(table.row_mode)) {
            errors.push(`table ${table.id}: invalid row_mode`);
        }
        for (const step of table.steps || []) {
            if (step.match) {
                const chk = safeRegex(step.match);
                if (!chk.ok) errors.push(`table ${table.id} step: ${chk.error}`);
            }
        }
    }

    return errors.length ? { ok: false, errors } : { ok: true, rule };
}

module.exports = { validateExtractionRuleV1, safeRegex };
