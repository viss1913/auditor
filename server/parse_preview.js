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

function runParse(filePath, rule, engineOpts = {}) {
    const validated = validateRule(rule);
    if (!validated.ok) {
        throw new Error(validated.errors.join('; '));
    }
    const out = runParseEngine(filePath, validated.rule, engineOpts);
    if (!out.ok) throw new Error(out.errors.join('; '));
    return { headers: out.headers, rows: out.rows, warnings: out.warnings || [], rule: out.rule };
}

/**
 * @param {string|null} filePath — null если передан engineOpts.sheetLoad
 * @param {Object} rule
 * @param {{ sheetLoad?: object, maxSourceRows?: number }} [engineOpts]
 */
function runParseFull(filePath, rule, engineOpts = {}) {
    const validated = validateRule(rule);
    if (!validated.ok) {
        return { ok: false, errors: validated.errors };
    }
    const out = runParseEngine(filePath, validated.rule, engineOpts);
    if (!out.ok) {
        return { ok: false, errors: out.errors };
    }
    return {
        ok: true,
        rule: out.rule,
        headers: out.headers,
        rows: out.rows,
        rowCount: out.rows.length,
        warnings: out.warnings,
        sheetName: out.sheetName,
    };
}

/**
 * @param {string|null} filePath
 * @param {Object} rule
 * @param {number} [previewRowLimit=50] — сколько строк отдать клиенту
 * @param {{ sheetLoad?: object, maxSourceRows?: number }} [engineOpts]
 *   maxSourceRows — быстрая проба: парсим только первые N строк листа (не весь файл)
 */
function runParsePreview(filePath, rule, previewRowLimit = 50, engineOpts = {}) {
    const full = runParseFull(filePath, rule, engineOpts);
    if (!full.ok) return full;
    return {
        ok: true,
        rule: full.rule,
        headers: full.headers,
        rows: full.rows.slice(0, previewRowLimit),
        rowCount: full.rowCount,
        warnings: full.warnings,
        sheetName: full.sheetName,
    };
}

/** Обрезка полного результата для клиента без повторного парса. */
function clientPreviewFromParseResult(full, previewRowLimit = 50) {
    if (!full?.ok) return full;
    return {
        ok: true,
        rule: full.rule,
        headers: full.headers,
        rows: full.rows.slice(0, previewRowLimit),
        rowCount: full.rowCount,
        warnings: full.warnings,
        sheetName: full.sheetName,
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

const PREVIEW_ROWS_CLIENT = 50;

module.exports = {
    validateRule,
    runParse,
    runParseFull,
    runParsePreview,
    clientPreviewFromParseResult,
    withTempFile,
    V2_ONLY_MSG,
    PREVIEW_ROWS_CLIENT,
};
