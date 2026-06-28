const { scoreDataRow, ISIN_RE } = require('./pdf_row_scoring');

const APPLICABLE_STATUSES = new Set(['approved', 'active', 'tested']);
const AUTO_APPLY_MIN = 0.75;
const AUTO_APPLY_CONFIDENT = 0.9;
const QUARANTINE_FAILURES = 3;

function historicalSuccessScore(scenarioRow) {
    const rule = scenarioRow?.ruleJson || scenarioRow?.rule_json || {};
    const stats = rule.stats || {};
    const success = Number(stats.success_count ?? scenarioRow?.successCount ?? 0);
    const failure = Number(stats.failure_count ?? scenarioRow?.failureCount ?? 0);
    const total = success + failure;
    if (total === 0) return 0.5;
    return success / total;
}

function headerMatchScore(signals, scenarioRow) {
    const rule = scenarioRow?.ruleJson || scenarioRow?.rule_json || {};
    const expected = (rule.columns || []).map((c) => String(c.label || c.target || '').toLowerCase());
    const sample = (signals?.headerSample || []).map((h) => String(h || '').toLowerCase());
    if (!expected.length || !sample.length) return 0.4;
    let hits = 0;
    for (const h of expected) {
        if (!h) continue;
        if (sample.some((s) => s.includes(h) || h.includes(s))) hits += 1;
    }
    return hits / Math.max(expected.length, 1);
}

function columnStructureScore(signals, scenarioRow) {
    const rule = scenarioRow?.ruleJson || scenarioRow?.rule_json || {};
    const expected =
        rule.validation?.expected_column_count ||
        rule.columns?.length ||
        rule.layout?.column_centers_norm?.length ||
        0;
    const actual = signals?.columnCount || signals?.columnCentersNorm?.length || 0;
    if (!expected || !actual) return 0.3;
    const diff = Math.abs(expected - actual);
    if (diff === 0) return 1;
    if (diff === 1) return 0.75;
    if (diff === 2) return 0.4;
    return 0.1;
}

function dataQualityScoreFromGrid(gridTable) {
    const rows = gridTable?.rows || [];
    const headers = gridTable?.headers || [];
    if (!rows.length || !headers.length) return 0;

    let isinHits = 0;
    let numericHits = 0;
    let emptyKey = 0;
    const keyCols = headers.slice(0, Math.min(3, headers.length));

    for (const row of rows) {
        const vals = keyCols.map((h) => String(row[h] ?? '').trim());
        const joined = vals.join(' ');
        if (ISIN_RE.test(joined)) isinHits += 1;
        if (vals.some((v) => /^-?\d/.test(v))) numericHits += 1;
        if (vals.filter(Boolean).length < Math.ceil(keyCols.length / 2)) emptyKey += 1;
    }

    const n = rows.length;
    const isinRate = isinHits / n;
    const numRate = numericHits / n;
    const emptyRate = emptyKey / n;
    return Math.max(0, Math.min(1, 0.4 * isinRate + 0.35 * numRate + 0.25 * (1 - emptyRate)));
}

/**
 * @param {object} params
 */
function computeQualityScore({ signals, scenarioRow, gridTable }) {
    const header = headerMatchScore(signals, scenarioRow);
    const structure = columnStructureScore(signals, scenarioRow);
    const data = gridTable ? dataQualityScoreFromGrid(gridTable) : 0.5;
    const history = historicalSuccessScore(scenarioRow);

    const quality_score =
        0.35 * header + 0.25 * structure + 0.25 * data + 0.15 * history;

    return {
        quality_score: Math.round(quality_score * 1000) / 1000,
        header_match_score: header,
        column_structure_score: structure,
        data_quality_score: data,
        historical_success_score: history,
    };
}

function scenarioAutoApplyDecision(qualityScore, status) {
    const st = String(status || 'draft').toLowerCase();
    if (st === 'draft' || st === 'rejected' || st === 'suspended' || st === 'archived') {
        return { apply: false, mode: 'blocked', reason: `status=${st}` };
    }
    if (!APPLICABLE_STATUSES.has(st)) {
        return { apply: false, mode: 'blocked', reason: `status=${st}` };
    }
    if (qualityScore < AUTO_APPLY_MIN) {
        return { apply: false, mode: 'low_score', reason: `quality=${qualityScore}` };
    }
    if (qualityScore >= AUTO_APPLY_CONFIDENT) {
        return { apply: true, mode: 'confident', warning: false };
    }
    return { apply: true, mode: 'warning', warning: true };
}

function shouldSuspendScenario(failureCount) {
    return Number(failureCount || 0) >= QUARANTINE_FAILURES;
}

function scoreRowDataQuality(rows, headers) {
    if (!rows?.length) return 0;
    let sum = 0;
    for (const row of rows) {
        sum += scoreDataRow({ text: headers.map((h) => row[h]).join(' ') });
    }
    return sum / rows.length;
}

module.exports = {
    PARSER_VERSION: 'pdf-grid-v2.1',
    APPLICABLE_STATUSES,
    AUTO_APPLY_MIN,
    AUTO_APPLY_CONFIDENT,
    QUARANTINE_FAILURES,
    computeQualityScore,
    scenarioAutoApplyDecision,
    shouldSuspendScenario,
    headerMatchScore,
    columnStructureScore,
    dataQualityScoreFromGrid,
    historicalSuccessScore,
};
