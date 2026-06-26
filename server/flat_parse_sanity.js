/**
 * Эвристики: когда probe/базовое правило подозрительны → нужен LLM flat-plan.
 * Пост-парс проверки для uk_card и generic.
 */
const { checkUkParseSanity } = require('./uk_sanity');

const ACCOUNT_LIKE_RE = /^\d{2}\.\d{2}(\.\d+)?$/;
const YEAR_METRIC_RE = /^\d{4}\s*-\s*(начало|амортизация|конец)/i;
const TURNOVER_LABEL_RE = /^обороты\s+за\s+\d{4}/i;

function cellLooksLikeAccount(val) {
    const s = String(val ?? '').trim();
    return ACCOUNT_LIKE_RE.test(s);
}

/**
 * @param {object} layoutMeta
 * @param {object} [ontology]
 */
function probeNeedsFlatParseRefinement(layoutMeta, ontology = null) {
    const ont = ontology || layoutMeta?.ontology || {};
    const probe = layoutMeta?.uk_probe || ont.uk_probe;
    const merges = layoutMeta?.merged_ranges?.length ?? 0;

    if (probe) {
        if (probe.amount_column === probe.credit_account_column) return true;
        if (probe.analytics_column === probe.document_column) return true;
        if (merges > 15 && probe.analytics_column <= probe.document_column) return true;
        if (ont.row_pattern === 'bu_kol_pairs' && probe.quantity_ambiguous) return true;
    }

    if (ont.has_tree && ont.layout_type === 'hierarchy_osv') {
        return false;
    }

    return false;
}

/**
 * Быстрая проверка preview после базового правила (без полного файла).
 * @param {string} scenarioId
 * @param {{ rows?: Array, rowCount?: number }} preview
 * @param {object} layoutMeta
 */
function previewFailsFlatSanity(scenarioId, preview, layoutMeta) {
    const rows = preview?.rows || [];
    if (!rows.length) return true;

    if (scenarioId === 'uk_card') {
        const sanity = checkUkParseSanity(rows, layoutMeta?.uk_probe || {});
        if (!sanity.ok) return true;
        const r0 = rows[0] || {};
        if (cellLooksLikeAccount(r0.amount)) return true;
        if (String(r0.name || '').match(/сделка\s+с\s+ц/i)) return true;
    }

    if (scenarioId === 'os_01_hierarchy' || scenarioId === 'os_01_flat' || scenarioId === 'wide_metrics') {
        const headers = preview?.headers || Object.keys(rows[0] || {});
        const yearHeaders = headers.filter((h) => YEAR_METRIC_RE.test(String(h)));
        if (yearHeaders.length >= 6) {
            const byYear = {};
            for (const h of yearHeaders) {
                const y = String(h).slice(0, 4);
                byYear[y] = (byYear[y] || 0) + 1;
            }
            const dupYears = Object.values(byYear).some((n) => n > 3);
            if (dupYears) return true;
        }
        const badRow = rows.find((row) =>
            Object.entries(row).some(([key, val]) => {
                if (!YEAR_METRIC_RE.test(key)) return false;
                const s = String(val ?? '').trim();
                return s && TURNOVER_LABEL_RE.test(s);
            })
        );
        if (badRow) return true;
        const r0 = rows[0] || {};
        if (YEAR_METRIC_RE.test(String(Object.keys(r0).find((k) => YEAR_METRIC_RE.test(k)) || ''))) {
            const metricKey = Object.keys(r0).find((k) => YEAR_METRIC_RE.test(k));
            const metricVal = metricKey ? r0[metricKey] : null;
            if (metricVal != null && String(metricVal).length > 40 && !/^-?\d/.test(String(metricVal).trim())) {
                return true;
            }
        }
    }

    return false;
}

/**
 * @param {string} scenarioId
 */
function scenarioUsesFlatParseEngine(scenarioId) {
    if (!scenarioId || scenarioId === 'custom_rule') return true;
    const { SCENARIO_CATALOG } = require('./scenarios/catalog');
    const entry = SCENARIO_CATALOG[scenarioId];
    if (!entry) return false;
    return entry.engine === 'parse_engine' || entry.engine === 'tree_walker';
}

module.exports = {
    probeNeedsFlatParseRefinement,
    previewFailsFlatSanity,
    scenarioUsesFlatParseEngine,
    cellLooksLikeAccount,
};
