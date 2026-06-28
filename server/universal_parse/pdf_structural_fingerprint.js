const crypto = require('crypto');
const { fingerprintHash } = require('./rule_cache');

const HEADER_FOOTNOTE_RE = /[\u00B9\u00B2\u00B3\u2070-\u2079\u2080-\u2089\u2080-\u2089]/g;

function normalizeHeaderText(h) {
    return String(h || '')
        .toLowerCase()
        .replace(HEADER_FOOTNOTE_RE, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
}

function normalizeMarker(m) {
    return String(m || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {object} input
 * @returns {string} 24-char hash
 */
function buildStructuralFingerprint(input) {
    const hdr = (input.headerSample || input.headers || [])
        .filter(Boolean)
        .slice(0, 3)
        .map(normalizeHeaderText);
    return fingerprintHash({
        docKind: input.docKind || input.doc_kind || 'unknown',
        brokerSubtype: input.brokerSubtype || input.broker_subtype || null,
        sectionId: input.sectionId || input.section_id || null,
        columnCount: Number(input.columnCount || input.column_count || 0),
        pageWidthPt: Math.round(Number(input.pageWidthPt || input.page_width_pt || 595)),
        hdr,
    });
}

function buildDetectionHash(markers) {
    const list = (markers || []).map(normalizeMarker).filter(Boolean).sort();
    return crypto.createHash('sha256').update(list.join('|')).digest('hex').slice(0, 24);
}

function countMarkerHits(text, markers) {
    const t = String(text || '').toLowerCase();
    let hits = 0;
    for (const m of markers || []) {
        const needle = normalizeMarker(m);
        if (needle && t.includes(needle)) hits++;
    }
    return hits;
}

function centerNormSimilarity(fileCentersNorm, ruleColumns) {
    const saved = (ruleColumns || [])
        .map((c) => Number(c.center_norm))
        .filter((n) => Number.isFinite(n));
    const file = (fileCentersNorm || []).map(Number).filter((n) => Number.isFinite(n));
    if (!saved.length || !file.length) return 0.5;
    const n = Math.min(saved.length, file.length);
    let sum = 0;
    for (let i = 0; i < n; i++) {
        sum += 1 - Math.min(1, Math.abs(saved[i] - file[i]) / 0.08);
    }
    return sum / n;
}

function headerSimilarity(sampleA, sampleB) {
    const a = (sampleA || []).map(normalizeHeaderText).filter(Boolean);
    const b = (sampleB || []).map(normalizeHeaderText).filter(Boolean);
    if (!a.length || !b.length) return 0;
    const n = Math.min(a.length, b.length);
    let match = 0;
    for (let i = 0; i < n; i++) {
        if (a[i] === b[i]) match++;
        else if (a[i].includes(b[i]) || b[i].includes(a[i])) match += 0.5;
    }
    return match / n;
}

/**
 * @param {object} fileSignals — сигналы из probe + grid preview
 * @param {object} scenarioRow — строка из pdf_parse_scenarios
 */
function scoreScenarioMatch(fileSignals, scenarioRow) {
    const rule = scenarioRow?.rule_json || scenarioRow?.ruleJson || {};
    const detection = rule.detection || {};
    const markers = detection.markers || [];
    const minHits = detection.min_marker_hits ?? 1;

    const markerHits = countMarkerHits(fileSignals.text || '', markers);
    if (markers.length && markerHits < minHits) {
        return { score: 0, markerHits, headerSim: 0, colMatch: 0, pageMatch: 0, centerSim: 0 };
    }

    const ruleHeaders =
        rule.detection?.probe_at_save?.header_sample?.length > 0
            ? rule.detection.probe_at_save.header_sample
            : (rule.columns || []).map((c) => c.label || c.target);
    const headerSim = headerSimilarity(fileSignals.headerSample, ruleHeaders);

    const expectedCols =
        rule.validation?.expected_column_count || rule.columns?.length || 0;
    const fileCols = Number(fileSignals.columnCount || 0);
    const colMatch =
        !expectedCols || !fileCols
            ? 0.5
            : expectedCols === fileCols
              ? 1
              : Math.abs(expectedCols - fileCols) <= 1
                ? 0.7
                : 0;

    const ruleWidth = Math.round(Number(rule.layout?.page_width_pt || 595));
    const fileWidth = Math.round(Number(fileSignals.pageWidthPt || 595));
    const pageMatch = ruleWidth === fileWidth ? 1 : Math.abs(ruleWidth - fileWidth) <= 5 ? 0.8 : 0.5;

    const centerSim = centerNormSimilarity(
        fileSignals.columnCentersNorm,
        rule.columns || []
    );

    const markerScore = markers.length ? Math.min(1, markerHits / Math.max(1, minHits)) : 0.5;
    const score =
        markerScore * 0.25 +
        headerSim * 0.3 +
        colMatch * 0.15 +
        pageMatch * 0.1 +
        centerSim * 0.2;

    return { score, markerHits, headerSim, colMatch, pageMatch, centerSim };
}

/** Сценарий можно автоприменить при повторной загрузке того же макета. */
function isScenarioAutoApplicable(scored, scenarioRow) {
    if (!scored || scored.score < 0.55) return false;
    const rule = scenarioRow?.rule_json || scenarioRow?.ruleJson || {};
    const markers = rule.detection?.markers || [];
    const minHits = rule.detection?.min_marker_hits ?? 1;
    if (markers.length && scored.markerHits >= minHits) return true;
    if ((scored.centerSim ?? 0) >= 0.85 && (scored.colMatch ?? 0) >= 0.7) return true;
    return scored.score >= 0.85;
}

function matchStatusFromScore(score) {
    if (score >= 0.85) return 'found';
    if (score >= 0.55) return 'similar';
    return 'missing';
}

let pdfjsModule = null;

async function getPdfjs() {
    if (!pdfjsModule) {
        pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfjsModule;
}

/**
 * @param {Buffer} buffer
 * @param {number} [pageNum]
 */
async function getPdfPageMetrics(buffer, pageNum = 1) {
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
        disableFontFace: true,
    }).promise;
    const page = await doc.getPage(Math.min(pageNum, doc.numPages));
    const viewport = page.getViewport({ scale: 1 });
    return {
        pageCount: doc.numPages,
        pageWidthPt: viewport.width,
        pageHeightPt: viewport.height,
    };
}

module.exports = {
    normalizeHeaderText,
    buildStructuralFingerprint,
    buildDetectionHash,
    countMarkerHits,
    headerSimilarity,
    centerNormSimilarity,
    scoreScenarioMatch,
    matchStatusFromScore,
    isScenarioAutoApplicable,
    getPdfPageMetrics,
};
