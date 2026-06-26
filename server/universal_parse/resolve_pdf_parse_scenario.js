const {
    buildStructuralFingerprint,
    scoreScenarioMatch,
    matchStatusFromScore,
    getPdfPageMetrics,
} = require('./pdf_structural_fingerprint');
const {
    listPdfParseScenarios,
    findByStructuralFp,
    bumpPdfParseScenarioHit,
} = require('./pdf_parse_scenario_store');
const { extractLayoutFromScenario } = require('./pdf_parse_scenario_coords');
const {
    extractTextItems,
    clusterRows,
    extractTableGridFromPdf,
    extractTableFromRows,
    findSectionRowIndex,
} = require('./pdfjs_table_grid_extract');
const { SECTION_DEFS } = require('./pdf_section_anchors');

const BUILTIN_KINDS = new Set(['upd_ediweb', 'depo']);

/**
 * @param {string} kind
 */
function isBuiltinPdfKind(kind) {
    return BUILTIN_KINDS.has(kind);
}

async function probeGridSignals(buffer, { sectionId, pdfProbe } = {}) {
    let pageWidthPt = 595.28;
    let pageHeightPt = 841.89;
    try {
        const metrics = await getPdfPageMetrics(buffer, 1);
        pageWidthPt = metrics.pageWidthPt;
        pageHeightPt = metrics.pageHeightPt;
    } catch {
        /* pdfjs unavailable */
    }

    let columnCount = 0;
    let headerSample = [];
    let gridConfidence = 0;

    try {
        const sectionDef = sectionId ? SECTION_DEFS.find((d) => d.id === sectionId) : null;
        if (sectionDef) {
            const grid = await extractTableGridFromPdf(buffer, {
                anchorStart: sectionDef.patterns[0],
                sectionId,
            });
            if (grid.ok) {
                columnCount = grid.headers?.length || 0;
                headerSample = (grid.headers || []).slice(0, 3);
                gridConfidence = grid.confidence || 0;
            }
        } else {
            const grid = await extractTableGridFromPdf(buffer);
            if (grid.ok) {
                columnCount = grid.headers?.length || 0;
                headerSample = (grid.headers || []).slice(0, 3);
                gridConfidence = grid.confidence || 0;
            }
        }
    } catch {
        /* auto grid failed */
    }

    const text = (pdfProbe?.lines || []).join('\n') || pdfProbe?.textSample || '';
    const docKind = pdfProbe?.kind || 'unknown';
    const brokerSubtype = pdfProbe?.brokerSubtype || null;

    const structuralFp = buildStructuralFingerprint({
        docKind,
        brokerSubtype,
        sectionId: sectionId || null,
        columnCount,
        pageWidthPt,
        headerSample,
    });

    return {
        text,
        docKind,
        brokerSubtype,
        sectionId: sectionId || null,
        columnCount,
        headerSample,
        pageWidthPt,
        pageHeightPt,
        structuralFp,
        gridConfidence,
    };
}

/**
 * @param {import('pg').Pool} pool
 * @param {Buffer} buffer
 * @param {object} pdfProbe
 * @param {object} [options]
 */
async function resolvePdfParseScenario(pool, buffer, pdfProbe, options = {}) {
    const catalogScenarioId =
        pdfProbe?.kind === 'broker_report'
            ? 'broker_pdf'
            : pdfProbe?.kind === 'upd_ediweb'
              ? 'upd_ediweb'
              : pdfProbe?.kind === 'depo'
                ? 'opif_depo'
                : 'pdf_extracted';

    if (isBuiltinPdfKind(pdfProbe?.kind)) {
        return {
            catalogScenarioId,
            catalogConfidence: pdfProbe?.confidence ?? 0.9,
            parseScenario: {
                status: 'builtin',
                scenarioId: null,
                scenarioName: pdfProbe.kind === 'upd_ediweb' ? 'УПД (встроенный)' : 'ДЕПО (встроенный)',
                matchScore: 1,
                candidates: [],
            },
        };
    }

    const signals = await probeGridSignals(buffer, {
        sectionId: options.sectionId,
        pdfProbe,
    });

    let candidates = [];
    if (pool) {
        try {
            const exact = await findByStructuralFp(pool, signals.structuralFp, {
                projectId: options.projectId,
            });
            const listed = await listPdfParseScenarios(pool, {
                projectId: options.projectId,
                docKind: signals.docKind,
                brokerSubtype: signals.brokerSubtype,
                sectionId: signals.sectionId,
            });

            const seen = new Set();
            const merged = [];
            for (const row of [...exact, ...listed]) {
                if (!row || seen.has(row.id)) continue;
                seen.add(row.id);
                const scored = scoreScenarioMatch(signals, row);
                merged.push({
                    id: row.id,
                    name: row.name,
                    version: row.version,
                    structuralFp: row.structuralFp,
                    docKind: row.docKind,
                    brokerSubtype: row.brokerSubtype,
                    sectionId: row.sectionId,
                    matchScore: scored.score,
                    ruleJson: row.ruleJson,
                });
            }
            candidates = merged
                .filter((c) => c.matchScore > 0.2)
                .sort((a, b) => b.matchScore - a.matchScore)
                .slice(0, 5);
        } catch (err) {
            if (process.env.PDF_SCENARIO_DEBUG === '1') {
                console.warn('[resolvePdfParseScenario]', err?.message || err);
            }
        }
    }

    const best = candidates[0] || null;
    const status = best ? matchStatusFromScore(best.matchScore) : 'missing';

    if (status === 'found' && best && pool) {
        try {
            await bumpPdfParseScenarioHit(pool, best.id);
        } catch {
            /* non-fatal */
        }
    }

    return {
        catalogScenarioId,
        catalogConfidence: pdfProbe?.confidence ?? 0.5,
        parseScenario: {
            status,
            scenarioId: status === 'found' ? best.id : null,
            scenarioName: best?.name || null,
            matchScore: best?.matchScore ?? 0,
            candidates: candidates.map((c) => ({
                id: c.id,
                name: c.name,
                matchScore: c.matchScore,
                version: c.version,
            })),
            signals: {
                structuralFp: signals.structuralFp,
                columnCount: signals.columnCount,
                pageWidthPt: signals.pageWidthPt,
            },
        },
        bestScenario: status === 'found' ? best : null,
        gridSignals: signals,
    };
}

/**
 * Применить сохранённый сценарий к grid extract.
 * @param {object} scenarioRow
 * @param {Buffer} buffer
 * @param {object} [options]
 */
async function extractWithPdfParseScenario(scenarioRow, buffer, options = {}) {
    const rule = scenarioRow?.ruleJson || scenarioRow?.rule_json;
    if (!rule) return null;

    const layout = extractLayoutFromScenario(rule, options.pageWidthPt);
    const sectionStart = rule.layout?.section_start?.pattern;
    const sectionEnd = rule.layout?.section_end?.pattern;

    const gridOpts = {
        columnCenters: layout.columnCenters,
        cachedHeaders: layout.headers,
        dataStart: layout.dataStart,
        xTol: layout.xTol,
        method: 'pdfjs_grid_scenario_v3',
        sectionId: rule.meta?.section_id || options.sectionId,
        visionHeaders: layout.headers,
    };

    if (sectionStart) {
        return extractTableGridFromPdf(buffer, {
            anchorStart: sectionStart,
            anchorEnd: sectionEnd || undefined,
            ...gridOpts,
        });
    }

    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    let startIdx = 0;
    let endIdx = rows.length;
    if (sectionStart) {
        const re = new RegExp(sectionStart, 'i');
        startIdx = findSectionRowIndex(rows, [re]);
        if (startIdx < 0) return { ok: false, headers: [], rows: [], confidence: 0 };
    }
    if (sectionEnd) {
        const re = new RegExp(sectionEnd, 'i');
        for (let i = startIdx + 1; i < rows.length; i++) {
            if (re.test(rows[i].text)) {
                endIdx = i;
                break;
            }
        }
    }
    return extractTableFromRows(rows, startIdx, endIdx, gridOpts);
}

module.exports = {
    isBuiltinPdfKind,
    probeGridSignals,
    resolvePdfParseScenario,
    extractWithPdfParseScenario,
};
