const crypto = require('crypto');
const {
    extractTextItems,
    clusterRows,
} = require('./pdfjs_table_grid_extract');
const { getPdfPageMetrics } = require('./pdf_structural_fingerprint');
const { suggestDataStartByScoring } = require('./pdf_row_scoring');
const { suggestDataStartRow } = require('./pdf_grid_preview_utils');
const { mergeContinuationLines } = require('./pdf_logical_rows');

const PARSER_VERSION = 'pdf-grid-v2.2';
const CACHE_TTL_MS = 30 * 60 * 1000;
const probeCache = new Map();

function fileHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function cacheKey({ fileHash: hash, page, parserVersion = PARSER_VERSION, documentId = '' }) {
    return `${documentId || 'doc'}:${hash}:${page}:${parserVersion}`;
}

function getCached(key) {
    const hit = probeCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
        probeCache.delete(key);
        return null;
    }
    return hit.payload;
}

function setCached(key, payload) {
    probeCache.set(key, { at: Date.now(), payload });
    if (probeCache.size > 200) {
        const oldest = probeCache.keys().next().value;
        probeCache.delete(oldest);
    }
}

function wordFromItem(it, pageW, pageH) {
    const x0 = it.x;
    const y0 = it.y;
    const x1 = it.x + (it.w || 0);
    const y1 = it.y + (it.h || 8);
    return {
        text: it.text,
        page: it.page,
        x0,
        y0,
        x1,
        y1,
        xNorm: pageW > 0 ? x0 / pageW : 0,
        yNorm: pageH > 0 ? y0 / pageH : 0,
        font_size: it.fontSize || null,
    };
}

function lineFromCluster(row, index, pageW, pageH) {
    const items = (row.items || []).map((it) => wordFromItem(it, pageW, pageH));
    return {
        index,
        page: row.page,
        y: row.y,
        yNorm: pageH > 0 ? row.y / pageH : null,
        text: row.text || items.map((w) => w.text).join(' '),
        items,
        word_ids: items.map((_, i) => i),
    };
}

/**
 * Логические строки: merge continuation (этап 3).
 */
function buildLogicalRows(physicalLines) {
    return mergeContinuationLines(physicalLines);
}

/**
 * @param {Buffer} buffer
 * @param {object} [opts]
 */
async function buildPdfProbeWords(buffer, opts = {}) {
    const page = parseInt(opts.page || '1', 10) || 1;
    const documentId = String(opts.documentId || opts.document_id || '').trim();
    const hash = opts.fileHash || fileHash(buffer);
    const key = cacheKey({ fileHash: hash, page, documentId });

    const cached = getCached(key);
    if (cached) return { ...cached, cache_hit: true };

    const metrics = await getPdfPageMetrics(buffer, page);
    const pageW = metrics.pageWidthPt;
    const pageH = metrics.pageHeightPt;
    const { items } = await extractTextItems(buffer, [page]);
    const clustered = clusterRows(items);

    const words = items.map((it) => wordFromItem(it, pageW, pageH));
    const physical_lines = clustered.map((row, index) => lineFromCluster(row, index, pageW, pageH));
    const logical_rows = buildLogicalRows(physical_lines);

    const scoredStart = suggestDataStartByScoring(clustered);
    const regexStart = suggestDataStartRow(clustered);
    const suggested_data_start_row =
        scoredStart > 0 || regexStart === 0 ? scoredStart : regexStart;

    const payload = {
        document_id: documentId || hash.slice(0, 16),
        file_hash: hash,
        page,
        page_width_pt: pageW,
        page_height_pt: pageH,
        words,
        physical_lines,
        logical_rows,
        clustered_rows: physical_lines.map((l) => ({
            index: l.index,
            text: l.text,
            yNorm: l.yNorm,
        })),
        suggested_data_start_row,
        parser_version: PARSER_VERSION,
        logical_row_count: logical_rows.length,
        physical_line_count: physical_lines.length,
        cache_hit: false,
    };

    setCached(key, payload);
    return payload;
}

module.exports = {
    PARSER_VERSION,
    fileHash,
    buildPdfProbeWords,
    cacheKey,
    getCached,
    setCached,
};
