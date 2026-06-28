const {
    buildStructuralFingerprint,
    scoreScenarioMatch,
    matchStatusFromScore,
    isScenarioAutoApplicable,
    getPdfPageMetrics,
} = require('./pdf_structural_fingerprint');
const {
    listPdfParseScenarios,
    findByStructuralFp,
    bumpPdfParseScenarioHit,
    getPdfParseScenarioById,
    recordPdfScenarioOutcome,
} = require('./pdf_parse_scenario_store');
const {
    computeQualityScore,
    scenarioAutoApplyDecision,
} = require('./pdf_scenario_quality');
const { extractLayoutFromScenario } = require('./pdf_parse_scenario_coords');
const { pageDataStartToGridDataStart } = require('./pdf_grid_preview_utils');
const {
    extractHeaderFields,
    applyHeaderFieldsToRows,
    normalizeHeaderFieldDefs,
} = require('./pdf_header_fields');
const {
    extractTextItems,
    clusterRows,
    extractTableGridFromPdf,
    extractTableFromRows,
    findSectionRowIndex,
} = require('./pdfjs_table_grid_extract');
const { SECTION_DEFS } = require('./pdf_section_anchors');

const SCENARIO_LIST_STATUSES = ['approved', 'active', 'tested'];

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
    let columnCentersNorm = [];
    let gridConfidence = 0;

    try {
        const sectionDef = sectionId ? SECTION_DEFS.find((d) => d.id === sectionId) : null;
        let grid;
        if (sectionDef) {
            grid = await extractTableGridFromPdf(buffer, {
                anchorStart: sectionDef.patterns[0],
                sectionId,
            });
        } else {
            grid = await extractTableGridFromPdf(buffer);
        }
        if (grid?.ok) {
            columnCount = grid.headers?.length || 0;
            headerSample = (grid.headers || []).slice(0, 3);
            gridConfidence = grid.confidence || 0;
            const centers = grid.meta?.columnCenters || [];
            if (centers.length && pageWidthPt > 0) {
                columnCentersNorm = centers.map((x) => Number(x) / pageWidthPt);
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
        columnCentersNorm,
        pageWidthPt,
        pageHeightPt,
        structuralFp,
        gridConfidence,
    };
}

/** Короткий tabular PDF — grid есть, но мало текстовых строк. */
function hasTabularGridLayout(signals) {
    return (
        Number(signals?.columnCount || 0) >= 2 &&
        (Number(signals?.gridConfidence || 0) > 0 || (signals?.columnCentersNorm?.length || 0) >= 2)
    );
}

function buildParseScenarioPayload({
    status,
    best,
    candidates,
    signals,
    llmSuggestion = null,
}) {
    return {
        status,
        scenarioId: status === 'found' || status === 'similar' ? best?.id ?? null : null,
        scenarioName: best?.name || null,
        matchScore: best?.matchScore ?? 0,
        candidates: candidates.map((c) => ({
            id: c.id,
            name: c.name,
            matchScore: c.matchScore,
            version: c.version,
            autoApply: c.autoApply,
            qualityScore: c.qualityScore ?? null,
            qualityMode: c.qualityMode ?? null,
            qualityWarning: c.qualityWarning ?? false,
            markerHits: c.markerHits,
        })),
        llmSuggestion,
        signals: {
            structuralFp: signals.structuralFp,
            columnCount: signals.columnCount,
            pageWidthPt: signals.pageWidthPt,
        },
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

    const forceId =
        options.forceScenarioId != null
            ? parseInt(options.forceScenarioId, 10)
            : null;
    if (pool && Number.isFinite(forceId) && forceId > 0) {
        const forced = await getPdfParseScenarioById(pool, forceId);
        if (forced) {
            const scored = scoreScenarioMatch(signals, forced);
            const candidate = {
                id: forced.id,
                name: forced.name,
                version: forced.version,
                structuralFp: forced.structuralFp,
                docKind: forced.docKind,
                brokerSubtype: forced.brokerSubtype,
                sectionId: forced.sectionId,
                matchScore: Math.max(scored.score, 0.95),
                autoApply: true,
                markerHits: scored.markerHits,
                ruleJson: forced.ruleJson,
            };
            try {
                await bumpPdfParseScenarioHit(pool, forced.id);
            } catch {
                /* non-fatal */
            }
            return {
                catalogScenarioId,
                catalogConfidence: pdfProbe?.confidence ?? 0.5,
                parseScenario: buildParseScenarioPayload({
                    status: 'found',
                    best: candidate,
                    candidates: [candidate],
                    signals,
                }),
                bestScenario: candidate,
                gridSignals: signals,
            };
        }
    }

    const looseKind =
        !signals.docKind ||
        signals.docKind === 'unknown' ||
        Boolean(pdfProbe?.ambiguous);

    let candidates = [];
    if (pool) {
        try {
            const exact = await findByStructuralFp(pool, signals.structuralFp, {
                statuses: SCENARIO_LIST_STATUSES,
            });
            const listed = await listPdfParseScenarios(pool, {
                docKind: signals.docKind,
                brokerSubtype: signals.brokerSubtype,
                sectionId: signals.sectionId,
                looseDocKind: looseKind,
                statuses: SCENARIO_LIST_STATUSES,
            });

            const seen = new Set();
            const merged = [];
            for (const row of [...exact, ...listed]) {
                if (!row || seen.has(row.id)) continue;
                seen.add(row.id);
                const scored = scoreScenarioMatch(signals, row);
                const quality = computeQualityScore({
                    signals,
                    scenarioRow: row,
                    gridTable: null,
                });
                const qualityDecision = scenarioAutoApplyDecision(quality.quality_score, row.status);
                const autoApply =
                    isScenarioAutoApplicable(scored, row) && qualityDecision.apply;
                merged.push({
                    id: row.id,
                    name: row.name,
                    version: row.version,
                    structuralFp: row.structuralFp,
                    docKind: row.docKind,
                    brokerSubtype: row.brokerSubtype,
                    sectionId: row.sectionId,
                    matchScore: scored.score,
                    autoApply,
                    qualityScore: quality.quality_score,
                    qualityMode: qualityDecision.mode,
                    qualityWarning: qualityDecision.warning || false,
                    markerHits: scored.markerHits,
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

    let best = candidates[0] || null;
    let llmSuggestion = null;

    const llmPick = await pickPdfScenarioWithLlm({
        fileSignals: signals,
        candidates,
        pdfProbe,
        fileName: options.fileName || '',
    });
    if (llmPick) {
        llmSuggestion = llmPick;
        if (
            llmPick.chosenScenarioId &&
            llmPick.confidence >= 0.7 &&
            !llmPick.askUser
        ) {
            const chosen = candidates.find((c) => c.id === llmPick.chosenScenarioId);
            if (chosen) {
                best = { ...chosen, matchScore: Math.max(chosen.matchScore, llmPick.confidence), autoApply: true };
            }
        }
    }

    const status = best
        ? best.autoApply
            ? best.matchScore >= 0.85 || (llmSuggestion?.confidence >= 0.7 && llmSuggestion?.chosenScenarioId === best.id)
                ? 'found'
                : 'similar'
            : matchStatusFromScore(best.matchScore)
        : 'missing';

    if ((status === 'found' || status === 'similar') && best?.autoApply && pool) {
        try {
            await bumpPdfParseScenarioHit(pool, best.id);
        } catch {
            /* non-fatal */
        }
    }

    return {
        catalogScenarioId,
        catalogConfidence: pdfProbe?.confidence ?? 0.5,
        parseScenario: buildParseScenarioPayload({
            status,
            best,
            candidates,
            signals,
            llmSuggestion,
        }),
        bestScenario: status === 'found' || status === 'similar' ? best : null,
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
    const pageDataStartRow = layout.pageDataStartRow;

    const gridOpts = {
        columnCenters: layout.columnCenters,
        cachedHeaders: layout.headers,
        xTol: layout.xTol,
        method: 'pdfjs_grid_scenario_v3',
        sectionId: rule.meta?.section_id || options.sectionId,
        visionHeaders: layout.headers,
        skipMultiCandidate: true,
    };

    let result;
    if (sectionStart) {
        const { items } = await extractTextItems(buffer);
        const rows = clusterRows(items);
        const re = new RegExp(sectionStart, 'i');
        const startIdx = findSectionRowIndex(rows, [re]);
        const gridDataStart =
            pageDataStartRow != null && startIdx >= 0
                ? pageDataStartToGridDataStart(pageDataStartRow, startIdx)
                : undefined;
        result = await extractTableGridFromPdf(buffer, {
            anchorStart: sectionStart,
            anchorEnd: sectionEnd || undefined,
            ...gridOpts,
            dataStart: gridDataStart,
        });
    } else {
        const { items } = await extractTextItems(buffer);
        const rows = clusterRows(items);
        let startIdx = 0;
        let endIdx = rows.length;
        if (sectionEnd) {
            const re = new RegExp(sectionEnd, 'i');
            for (let i = startIdx + 1; i < rows.length; i++) {
                if (re.test(rows[i].text)) {
                    endIdx = i;
                    break;
                }
            }
        }
        const gridDataStart =
            pageDataStartRow != null
                ? pageDataStartToGridDataStart(pageDataStartRow, startIdx)
                : undefined;
        result = extractTableFromRows(rows, startIdx, endIdx, {
            ...gridOpts,
            dataStart: gridDataStart,
        });
    }

    const headerFieldDefs = normalizeHeaderFieldDefs(rule.header_fields);
    if (headerFieldDefs.length && result?.rows?.length) {
        const { items } = await extractTextItems(buffer);
        const clustered = clusterRows(items);
        const values = extractHeaderFields(
            clustered,
            pageDataStartRow ?? clustered.length,
            headerFieldDefs
        );
        const applied = applyHeaderFieldsToRows(
            result.rows,
            result.headers,
            values,
            headerFieldDefs
        );
        result = { ...result, headers: applied.headers, rows: applied.rows };
    }

    return result;
}

module.exports = {
    isBuiltinPdfKind,
    probeGridSignals,
    hasTabularGridLayout,
    resolvePdfParseScenario,
    extractWithPdfParseScenario,
};
