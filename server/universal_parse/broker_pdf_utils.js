/** Общие утилиты брокерских PDF (ATON, ClnBIS/VTB, GI Solutions). */

/** ISIN: RU/US/XS и др. — 12 символов. */
const ISIN_RE = /[A-Z]{2}[A-Z0-9]{10}/;

/**
 * @param {string} subtype
 * @returns {boolean}
 */
function usesBrokerGridPipeline(subtype) {
    return subtype === 'aton' || subtype === 'vtb';
}

/** ATON / ClnBIS (GI Solutions) / ВТБ — общая шапка отчёта в текстовом слое. */
function usesBrokerReportHeader(subtype) {
    return usesBrokerGridPipeline(subtype);
}

module.exports = { ISIN_RE, usesBrokerGridPipeline, usesBrokerReportHeader };
