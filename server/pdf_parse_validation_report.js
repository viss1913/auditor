/**
 * Валидация preview PDF перед импортом в snapshot.
 */
const { PDF_VALIDATION_STRICT, IMPORT_MIN_CONFIDENCE, DUAL_EXTRACT_HEADER_OVERLAP_MIN } = require('./confidence_thresholds');
const { ISIN_RE } = require('./universal_parse/broker_pdf_utils');

const MIN_ROW_COUNT = 1;
const EMPTY_COLUMN_RATIO_FAIL = 0.4;
const SUSPICIOUS_COLUMN_RATIO_WARN = 0.3;

function makeCheck(id, title, status, expected, actual, detail = '') {
    return { id, title, status, expected, actual, detail };
}

function worstStatus(checks) {
    if (checks.some((c) => c.status === 'fail')) return 'fail';
    if (checks.some((c) => c.status === 'warn')) return 'warn';
    return 'pass';
}

function previewRowCount(preview) {
    return preview?.rowCount ?? preview?.rows?.length ?? 0;
}

function checkRowCount(preview) {
    const count = previewRowCount(preview);
    if (count < MIN_ROW_COUNT) {
        return makeCheck('row_count', 'Количество строк', 'fail', '>= 1', String(count));
    }
    if (count < 3) {
        return makeCheck('row_count', 'Количество строк', 'warn', '>= 3', String(count));
    }
    return makeCheck('row_count', 'Количество строк', 'pass', '>= 1', String(count));
}

function checkHeaderQuality(preview, gridDiagnostics) {
    const headers = preview?.headers || [];
    if (!headers.length) {
        return makeCheck('header_quality', 'Заголовки', 'fail', '>= 2 колонок', '0');
    }
    if (headers.length < 2) {
        return makeCheck('header_quality', 'Заголовки', 'warn', '>= 2', String(headers.length));
    }

    const suspicious = gridDiagnostics?.suspiciousCols || [];
    const ratio = headers.length ? suspicious.length / headers.length : 0;
    if (ratio > EMPTY_COLUMN_RATIO_FAIL) {
        return makeCheck(
            'header_quality',
            'Пустые колонки',
            'fail',
            `< ${Math.round(EMPTY_COLUMN_RATIO_FAIL * 100)}% пустых`,
            `${Math.round(ratio * 100)}%`,
            suspicious
                .slice(0, 3)
                .map((c) => `«${c.header}»: ${Math.round(c.emptyRatio * 100)}% пустых`)
                .join('; ')
        );
    }
    if (ratio > SUSPICIOUS_COLUMN_RATIO_WARN) {
        return makeCheck(
            'header_quality',
            'Пустые колонки',
            'warn',
            `< ${Math.round(SUSPICIOUS_COLUMN_RATIO_WARN * 100)}% подозрительных`,
            `${Math.round(ratio * 100)}%`
        );
    }
    return makeCheck('header_quality', 'Колонки', 'pass', 'ok', String(headers.length));
}

function checkColumnCount(preview, expectedColumnCount) {
    const actual = (preview?.headers || []).length;
    const expected = expectedColumnCount || actual;
    if (!expected || actual === expected) {
        return makeCheck('column_count', 'Число колонок', 'pass', String(expected), String(actual));
    }
    return makeCheck(
        'column_count',
        'Число колонок',
        'warn',
        String(expected),
        String(actual),
        `Ожидали ${expected}, нашли ${actual}`
    );
}

function checkKindConsistency(preview, pdfProbe) {
    if (pdfProbe?.kind !== 'broker_report') {
        return makeCheck('kind_consistency', 'Согласованность типа', 'pass', 'n/a', 'n/a');
    }
    const rows = preview?.rows || [];
    const sample = rows.slice(0, 20);
    let hasSignal = false;
    for (const row of sample) {
        const vals = Object.values(row || {}).map((v) => String(v ?? ''));
        const joined = vals.join(' ');
        if (ISIN_RE.test(joined) || /\d{2}\.\d{2}\.\d{2,4}/.test(joined)) {
            hasSignal = true;
            break;
        }
    }
    if (!hasSignal && sample.length >= 2) {
        return makeCheck(
            'kind_consistency',
            'Брокер: даты/ISIN в данных',
            'warn',
            'есть в sample',
            'нет',
            'Возможно неверный раздел или склейка колонок'
        );
    }
    return makeCheck('kind_consistency', 'Брокер: даты/ISIN', 'pass', 'ok', hasSignal ? 'да' : 'мало строк');
}

function headerOverlap(headersA, headersB) {
    const norm = (h) =>
        String(h || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    const setA = new Set((headersA || []).map(norm).filter(Boolean));
    const setB = new Set((headersB || []).map(norm).filter(Boolean));
    if (!setA.size || !setB.size) return 0;
    let overlap = 0;
    for (const h of setA) {
        if (setB.has(h)) overlap++;
    }
    return overlap / Math.max(setA.size, setB.size);
}

function checkDualExtract(preview, dualExtract, pdfProbe) {
    if (pdfProbe?.kind !== 'broker_report' || !dualExtract) {
        return makeCheck('dual_extract', 'Сверка extractors', 'pass', 'n/a', 'n/a');
    }
    const overlap = dualExtract.headerOverlap ?? headerOverlap(preview?.headers, dualExtract.headers);
    if (overlap < DUAL_EXTRACT_HEADER_OVERLAP_MIN) {
        return makeCheck(
            'dual_extract',
            'Сверка grid vs line',
            'fail',
            `>= ${Math.round(DUAL_EXTRACT_HEADER_OVERLAP_MIN * 100)}% headers`,
            `${Math.round(overlap * 100)}%`,
            dualExtract.note || 'Расхождение методов извлечения'
        );
    }
    if (overlap < DUAL_EXTRACT_HEADER_OVERLAP_MIN + 0.15) {
        return makeCheck(
            'dual_extract',
            'Сверка grid vs line',
            'warn',
            `>= ${Math.round((DUAL_EXTRACT_HEADER_OVERLAP_MIN + 0.15) * 100)}%`,
            `${Math.round(overlap * 100)}%`
        );
    }
    return makeCheck('dual_extract', 'Сверка grid vs line', 'pass', 'ok', `${Math.round(overlap * 100)}%`);
}

function buildSummary(status, failedChecks, rowCount) {
    if (status === 'pass') return `PDF preview ок (${rowCount} строк)`;
    const names = failedChecks.map((c) => c.id).join(', ');
    return `PDF validation ${status}: ${names}`;
}

/**
 * @param {{
 *   preview: object,
 *   pdfProbe?: object,
 *   gridDiagnostics?: object,
 *   dualExtract?: object,
 *   expectedColumnCount?: number,
 *   savedScenarioFound?: boolean,
 * }} input
 */
function buildPdfParseValidationReport(input = {}) {
    const { preview, pdfProbe, gridDiagnostics, dualExtract, expectedColumnCount, savedScenarioFound } = input;

    if (savedScenarioFound) {
        return {
            ok: true,
            status: 'pass',
            skipped: true,
            reason: 'saved_scenario',
            checks: [],
            summary: 'Saved PDF scenario — validation skipped',
        };
    }

    const checks = [
        checkRowCount(preview),
        checkHeaderQuality(preview, gridDiagnostics),
        checkColumnCount(preview, expectedColumnCount),
        checkKindConsistency(preview, pdfProbe),
        checkDualExtract(preview, dualExtract, pdfProbe),
    ];

    const status = worstStatus(checks);
    const failedChecks = checks.filter((c) => c.status !== 'pass');
    const rowCount = previewRowCount(preview);
    const blocksImport = PDF_VALIDATION_STRICT && status === 'fail';

    return {
        ok: status !== 'fail',
        status,
        blocksImport,
        checks,
        summary: buildSummary(status, failedChecks, rowCount),
    };
}

module.exports = {
    buildPdfParseValidationReport,
    headerOverlap,
};
