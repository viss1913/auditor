/**
 * Единый экстрактор таблицы раздела брокерского PDF:
 * кэш layout → pdfjs grid → vision structure → regex fallback.
 */

const { fingerprintHash, getCachedSectionLayout, setCachedSectionLayout } = require('./rule_cache');
const { isSectionAnchorRow } = require('./pdf_section_anchors');
const {
    extractTextItems,
    clusterRows,
    extractTableFromRows,
    findSectionRowIndex,
    countNonEmptyHeaders,
    needsVisionStructure,
    isMessyGridHeaders,
} = require('./pdfjs_table_grid_extract');
const { extractTableStructureFromPdf, isDocumentScanEnabled } = require('../document_scan_llm');
const { usesBrokerGridPipeline } = require('./broker_pdf_utils');
const { listPdfParseScenarios } = require('./pdf_parse_scenario_store');
const { extractWithPdfParseScenario } = require('./resolve_pdf_parse_scenario');

function shouldTryVisionStructure(gridResult, sectionId, options = {}) {
    if (!isDocumentScanEnabled() || options.allowVision === false) return false;
    if (options.brokerSubtype === 'vtb' && (sectionId === 'reserved' || sectionId === 'operations')) return false;
    const alwaysOn = String(process.env.BROKER_PDF_VISION_ALWAYS ?? '1').trim() !== '0';
    if (alwaysOn && (sectionId === 'encumbered' || sectionId === 'trades' || sectionId === 'reserved')) {
        return true;
    }
    return needsVisionStructure(gridResult, sectionId);
}

function buildLayoutFingerprint(brokerSubtype, sectionId, columnCenters, headers) {
    const centers = (columnCenters || []).map((x) => Math.round(x));
    const hdrSample = (headers || [])
        .filter(Boolean)
        .slice(0, 3)
        .map((h) => String(h).slice(0, 80));
    return fingerprintHash({
        brokerSubtype: brokerSubtype || 'unknown',
        sectionId,
        centers,
        hdrSample,
    });
}

function isSuspiciousReservedGrid(gridResult) {
    const row = gridResult?.rows?.[0];
    if (!row) return false;
    const nums = Object.values(row)
        .filter((v) => v != null && String(v).trim() !== '')
        .map((v) => String(v).replace(/\s/g, '').replace(',', '.'))
        .filter((v) => /^-?\d+(\.\d+)?$/.test(v));
    if (nums.length < 3) return false;
    return new Set(nums).size === 1;
}

function countFilledSumRows(result) {
    const headers = result?.headers || [];
    const sumKey = headers.find((h) => /сумма/i.test(String(h)));
    if (!sumKey) return 0;
    return (result.rows || []).filter((r) => r[sumKey] != null && String(r[sumKey]).trim()).length;
}

function isSuspiciousSplitTradesGrid(gridResult, regexResult) {
    if (!gridResult?.rows?.length || !regexResult?.rows?.length) return false;
    if (gridResult.rows.length < regexResult.rows.length * 1.55) return false;
    const dealKey =
        (gridResult.headers || []).find((h) => /сделк/i.test(String(h))) ||
        (regexResult.headers || []).find((h) => /сделк/i.test(String(h)));
    if (!dealKey) return true;
    const sample = gridResult.rows.slice(0, 12);
    const splitRows = sample.filter((r) => {
        const v = String(r[dealKey] || '');
        return /mcxs\d+,\s*$/i.test(v) || (v.includes('mcxs') && !/\d{2}\.\d{2}\.\d{2}/.test(v));
    });
    return splitRows.length >= Math.min(4, Math.ceil(sample.length / 2));
}

function shouldPreferTradesGrid(gridResult, regexResult) {
    const gridRows = gridResult?.rows?.length || 0;
    const regexRows = regexResult?.rows?.length || 0;
    const gridCols = gridResult.meta?.columns || countNonEmptyHeaders(gridResult.headers);
    if (!gridRows || gridCols < 15) return false;
    if (isSuspiciousSplitTradesGrid(gridResult, regexResult)) return false;
    if (gridRows >= regexRows) return true;
    // pdf-parse slice иногда раздувает regex; grid с полной шириной таблицы надёжнее
    return gridRows >= regexRows * 0.9 && gridCols >= 20;
}

function isSuspiciousOperationsGrid(gridResult) {
    const row = gridResult?.rows?.[0];
    if (!row) return false;
    const mergedTail = Object.values(row).some((v) =>
        /^-?\d+,\d{2}\s+\d{6,}$/.test(String(v || '').trim())
    );
    const sumKey = (gridResult.headers || []).find((h) => /сумма/i.test(String(h)));
    const sumMissing = !sumKey || row[sumKey] == null || String(row[sumKey]).trim() === '';
    const overflowCol = Object.keys(row).some(
        (k) => /^col_/i.test(k) && /-?\d+,\d{2}/.test(String(row[k] || ''))
    );
    return mergedTail || sumMissing || overflowCol;
}

function pickSectionExtract(gridResult, regexResult, options = {}) {
    const gridOk = gridResult?.ok && gridResult.rows?.length;
    const regexOk = regexResult?.ok && regexResult.rows?.length;

    if (!gridOk && !regexOk) {
        return regexResult || gridResult || { ok: false, headers: [], rows: [], confidence: 0, method: 'none' };
    }
    if (!gridOk) return regexResult;
    if (!regexOk) {
        return {
            ok: true,
            headers: gridResult.headers,
            rows: gridResult.rows,
            confidence: gridResult.confidence,
            method: gridResult.method || 'pdfjs_grid',
            meta: gridResult.meta,
        };
    }

    const gridCols = countNonEmptyHeaders(gridResult.headers);
    const regexCols = countNonEmptyHeaders(regexResult.headers);
    const gridMetaCols = gridResult.meta?.columns || gridCols;

    const regexLabels = countLabeledRows(regexResult);
    const gridLabels = countLabeledRows(gridResult);

    const preferGrid =
        (options.sectionId === 'trades'
            ? shouldPreferTradesGrid(gridResult, regexResult)
            : gridResult.rows.length >= regexResult.rows.length) &&
        (gridCols >= regexCols || gridMetaCols >= 5) &&
        !(options.sectionId === 'assets' && regexLabels > gridLabels) &&
        !(
            options.sectionId === 'reserved' &&
            regexResult?.method === 'clnbis_reserved_grid' &&
            isSuspiciousReservedGrid(gridResult)
        ) &&
        !(
            options.sectionId === 'reserved' &&
            isSuspiciousReservedGrid(gridResult) &&
            regexOk
        ) &&
        !(
            options.sectionId === 'operations' &&
            regexOk &&
            countFilledSumRows(regexResult) > countFilledSumRows(gridResult)
        ) &&
        !(
            options.sectionId === 'operations' &&
            regexOk &&
            (regexResult?.method === 'clnbis_operations_grid' ||
                regexResult?.method === 'aton_operations') &&
            isSuspiciousOperationsGrid(gridResult)
        );

    if (preferGrid) {
        return {
            ok: true,
            headers: gridResult.headers,
            rows: gridResult.rows,
            confidence: Math.max(gridResult.confidence || 0, regexResult.confidence || 0),
            method: gridResult.method || 'pdfjs_grid_native_headers',
            meta: gridResult.meta,
        };
    }
    return regexResult;
}

function countLabeledRows(result) {
    const rows = result?.rows || [];
    const headers = result?.headers || [];
    if (!rows.length) return 0;
    const labelKey =
        headers.find((h) => /показатель/i.test(String(h))) ||
        headers.find((h) => /стоимость\s+актив/i.test(String(h))) ||
        headers[0];
    return rows.filter((r) => {
        const v = r[labelKey];
        return v != null && String(v).trim() && !/^(RUR|USD|EUR)$/i.test(String(v).trim());
    }).length;
}

function findSectionBounds(rows, sectionDef, allDefs) {
    const starts = [];
    for (let i = 0; i < rows.length; i++) {
        for (const def of allDefs) {
            if (isSectionAnchorRow(rows[i].text, def)) {
                starts.push({ index: i, def });
                break;
            }
        }
    }
    starts.sort((a, b) => a.index - b.index);
    const deduped = [];
    const seen = new Set();
    for (const s of starts) {
        if (seen.has(s.def.id)) continue;
        seen.add(s.def.id);
        deduped.push(s);
    }

    const pos = deduped.findIndex((s) => s.def.id === sectionDef.id);
    if (pos < 0) return null;

    const startIdx = deduped[pos].index;
    const endIdx = pos + 1 < deduped.length ? deduped[pos + 1].index : rows.length;
    return { startIdx, endIdx, sectionPage: rows[startIdx]?.page ?? null };
}

async function tryDbPdfScenarioExtract(buffer, sectionDef, brokerSubtype, options = {}) {
    if (!options.pool) return null;
    try {
        const scenarios = await listPdfParseScenarios(options.pool, {
            projectId: options.projectId,
            docKind: 'broker_report',
            brokerSubtype,
            sectionId: sectionDef.id,
        });
        for (const sc of scenarios.slice(0, 8)) {
            const ex = await extractWithPdfParseScenario(sc, buffer, { sectionId: sectionDef.id });
            if (ex?.ok && ex.rows?.length && (ex.confidence || 0) >= 0.45) {
                return ex;
            }
        }
    } catch {
        /* non-fatal */
    }
    return null;
}

async function extractSectionTableGrid(buffer, sectionDef, allSectionDefs, brokerSubtype, options = {}) {
    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const bounds = findSectionBounds(rows, sectionDef, allSectionDefs);
    if (!bounds) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'pdfjs_grid' };
    }

    const gridOpts = {
        xTol: options.xTol || 40,
        method: 'pdfjs_grid_native_headers',
        sectionId: sectionDef.id,
    };
    let extracted = await tryDbPdfScenarioExtract(buffer, sectionDef, brokerSubtype, options);
    if (!extracted?.ok || !extracted?.rows?.length) {
        extracted = extractTableFromRows(rows, bounds.startIdx, bounds.endIdx, gridOpts);
    }

    const layoutFingerprint = options.layoutFingerprint || null;

    if (shouldTryVisionStructure(extracted, sectionDef.id, { ...options, brokerSubtype })) {
        try {
            const structure = await extractTableStructureFromPdf({
                buffer,
                fileName: options.fileName || 'document.pdf',
                sectionTitle: sectionDef.label,
                pageHint: bounds.sectionPage,
            });
            if (structure.headers?.length >= 2 && (structure.confidence || 0) >= 0.5) {
                // Vision только для подписей колонок — координаты и строки не трогаем.
                const retry = extractTableFromRows(rows, bounds.startIdx, bounds.endIdx, {
                    ...gridOpts,
                    visionHeaders: structure.headers,
                    targetColumnCount: structure.columnCount || structure.headers.length,
                    method: 'pdfjs_grid_vision_headers',
                    visionLayoutOnly: true,
                });
                if (retry.ok && retry.rows.length) {
                    extracted = {
                        ...retry,
                        meta: {
                            ...(retry.meta || {}),
                            visionUsedFor: 'headers_only',
                        },
                    };
                }
            }
        } catch (err) {
            if (process.env.BROKER_PDF_VISION_DEBUG === '1') {
                console.warn(`[vision] ${sectionDef.id}:`, err?.message || err);
            }
        }
    }

    const cached = getCachedSectionLayout(brokerSubtype, sectionDef.id, layoutFingerprint);
    const tradesCacheOk =
        sectionDef.id !== 'trades' ||
        (cached?.columnCenters?.length >= 18 && cached.columnCenters.length <= 23);
    if (
        !extracted.method?.includes('vision') &&
        cached?.columnCenters?.length &&
        tradesCacheOk &&
        !isMessyGridHeaders(cached.headers)
    ) {
        const cachedExtract = extractTableFromRows(rows, bounds.startIdx, bounds.endIdx, {
            ...gridOpts,
            columnCenters: cached.columnCenters,
            cachedHeaders: cached.headers,
            dataStart: cached.dataStart ?? undefined,
            xTol: cached.xTol ?? gridOpts.xTol,
            method: 'pdfjs_grid_cached',
        });
        const cachedCols = cachedExtract.meta?.columns || 0;
        const freshCols = extracted.meta?.columns || 0;
        const cachedLooksSplit =
            sectionDef.id === 'trades' &&
            (isSuspiciousSplitTradesGrid(cachedExtract, extracted) ||
                cachedCols > 23 ||
                cachedCols < 18);
        if (
            !cachedLooksSplit &&
            (cachedCols > freshCols ||
                (cachedCols === freshCols &&
                    cachedExtract.rows.length >= extracted.rows.length &&
                    !(
                        sectionDef.id === 'trades' &&
                        extracted.rows.length > 0 &&
                        cachedExtract.rows.length > extracted.rows.length * 1.35
                    )))
        ) {
            extracted = cachedExtract;
        }
    }

    if (extracted.ok && extracted.rows.length && extracted.meta?.columnCenters?.length) {
        const cols = extracted.meta.columnCenters.length;
        const saveTradesCache =
            sectionDef.id !== 'trades' || (cols >= 18 && cols <= 23);
        if (saveTradesCache) {
            setCachedSectionLayout(brokerSubtype, sectionDef.id, layoutFingerprint, {
                headers: extracted.headers,
                columnCenters: extracted.meta.columnCenters,
                dataStart: extracted.meta.dataStart,
                headerRowCount: extracted.meta.headerRowCount,
                xTol: extracted.meta.xTol,
            });
        }
    }

    return extracted;
}

/**
 * @param {Buffer} buffer
 * @param {{ id: string, label: string, patterns: RegExp[] }} sectionDef
 * @param {{ id: string, label: string, patterns: RegExp[] }[]} allSectionDefs
 * @param {string} brokerSubtype
 * @param {{ regexExtract?: object, fileName?: string, allowVision?: boolean }} [options]
 */
async function extractSectionTable(buffer, sectionDef, allSectionDefs, brokerSubtype, options = {}) {
    let gridResult = { ok: false, headers: [], rows: [], confidence: 0, method: 'none' };

    if (buffer && usesBrokerGridPipeline(brokerSubtype)) {
        try {
            gridResult = await extractSectionTableGrid(buffer, sectionDef, allSectionDefs, brokerSubtype, {
                fileName: options.fileName,
                allowVision: options.allowVision,
                layoutFingerprint: options.layoutFingerprint,
            });
        } catch {
            gridResult = { ok: false, headers: [], rows: [], confidence: 0, method: 'pdfjs_grid' };
        }
    }

    const picked = pickSectionExtract(gridResult, options.regexExtract, { sectionId: sectionDef.id });
    return picked;
}

module.exports = {
    extractSectionTable,
    extractSectionTableGrid,
    pickSectionExtract,
    isSuspiciousSplitTradesGrid,
    shouldPreferTradesGrid,
    buildLayoutFingerprint,
    findSectionBounds,
};
