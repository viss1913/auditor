const fs = require('fs');
const os = require('os');
const path = require('path');
const { isV2Rule, validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const { runParseEngine } = require('./parse_engine');

const V2_ONLY_MSG =
    'Нужно ParsingRule v2 (rule_schema_version: 2). Создайте или отредактируйте правило в AI Martin.';

function validateRule(rule) {
    if (!isV2Rule(rule)) {
        return { ok: false, errors: [V2_ONLY_MSG] };
    }
    return validateParsingRuleV2(rule);
}

function runParse(filePath, rule) {
    const validated = validateRule(rule);
    if (!validated.ok) {
        throw new Error(validated.errors.join('; '));
    }
    const out = runParseEngine(filePath, validated.rule);
    if (!out.ok) throw new Error(out.errors.join('; '));
    return { headers: out.headers, rows: out.rows, warnings: out.warnings || [] };
}

function runParseFull(filePath, rule) {
    const validated = validateRule(rule);
    if (!validated.ok) {
        return { ok: false, errors: validated.errors };
    }
    const { headers, rows, warnings = [] } = runParse(filePath, validated.rule);
    return {
        ok: true,
        rule: validated.rule,
        headers,
        rows,
        rowCount: rows.length,
        warnings,
    };
}

function runParsePreview(filePath, rule, limit = 50) {
    const full = runParseFull(filePath, rule);
    if (!full.ok) return full;
    return {
        ok: true,
        rule: full.rule,
        headers: full.headers,
        rows: full.rows.slice(0, limit),
        rowCount: full.rowCount,
        warnings: full.warnings,
    };
}

function withTempFile(buffer, originalName, fn) {
    const ext = path.extname(originalName || '.xlsx') || '.xlsx';
    const tmp = path.join(os.tmpdir(), `auditor_parse_${Date.now()}${ext}`);
    fs.writeFileSync(tmp, buffer);
    try {
        return fn(tmp);
    } finally {
        try {
            fs.unlinkSync(tmp);
        } catch (e) {
            /* ignore */
        }
    }
}

const PREVIEW_ROWS_CLIENT = 200;

module.exports = {
    validateRule,
    runParse,
    runParseFull,
    runParsePreview,
    withTempFile,
    V2_ONLY_MSG,
    PREVIEW_ROWS_CLIENT,
};
