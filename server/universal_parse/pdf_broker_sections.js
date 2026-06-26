const { extractPdfTablesFromLines } = require('./pdf_table_extract');
const { extractAtonSection, extractClnbisReservedFromBuffer, extractClnbisOperationsFromBuffer, extractAtonCashOperationsFromBuffer, extractAtonTradesFromBuffer, parseAtonReportHeader, applyAtonReportHeader } = require('./aton_broker_extract');
const { extractLimanBrokerPdfTables } = require('./liman_broker_extract');
const { extractOrionClientReportTables } = require('./orion_client_report_extract');
const { extractSectionTable } = require('./pdf_section_table_extract');
const { SECTION_DEFS, isSectionAnchorRow, findSectionAnchorStarts } = require('./pdf_section_anchors');
const { usesBrokerGridPipeline, usesBrokerReportHeader } = require('./broker_pdf_utils');

function findSectionStarts(lines) {
    return findSectionAnchorStarts(lines);
}

function resolveSectionsFromMessage(userMessage) {
    const t = String(userMessage || '').toLowerCase();
    if (!t.trim()) return null;
    if (/все\s+раздел|все\s+таблиц|кажд[а-яё]*\s+таблиц/i.test(t)) return null;
    const matched = SECTION_DEFS.filter((def) =>
        def.messageHints.some((re) => re.test(t))
    );
    return matched.length ? matched.map((d) => d.id) : null;
}

/**
 * @param {string[]} lines
 * @param {string} [userMessage]
 * @param {{ brokerSubtype?: string, pdfBuffer?: Buffer, fileName?: string, layoutFingerprint?: object, pool?: object, projectId?: number|string }} [options]
 */
async function extractBrokerPdfSectionTables(lines, userMessage = '', options = {}) {
    const brokerSubtype = options.brokerSubtype || 'unknown';
    const src = (lines || []).map((l) => String(l || '').trim()).filter(Boolean);

    if (brokerSubtype === 'orion_client_report' && options.pdfBuffer) {
        return extractOrionClientReportTables(options.pdfBuffer);
    }

    if (brokerSubtype === 'liman' && options.pdfBuffer) {
        return extractLimanBrokerPdfTables(options.pdfBuffer);
    }

    if (src.length < 5) return [];

    const brokerHeaderMeta = usesBrokerReportHeader(brokerSubtype) ? parseAtonReportHeader(src) : null;

    const starts = findSectionStarts(src);
    if (!starts.length) return [];

    const filterIds = resolveSectionsFromMessage(userMessage);
    const sections = [];

    for (let i = 0; i < starts.length; i++) {
        const { index, def } = starts[i];
        if (filterIds && !filterIds.includes(def.id)) continue;

        const end = i + 1 < starts.length ? starts[i + 1].index : src.length;
        const slice = src.slice(index, end);

        const gridPipeline = usesBrokerGridPipeline(brokerSubtype);
        let regexExtracted = gridPipeline
            ? extractAtonSection(def.id, slice)
            : extractPdfTablesFromLines(slice);

        if (
            gridPipeline &&
            brokerSubtype === 'vtb' &&
            def.id === 'reserved' &&
            options.pdfBuffer
        ) {
            const clnbis = await extractClnbisReservedFromBuffer(options.pdfBuffer, SECTION_DEFS);
            if (clnbis.ok && clnbis.rows.length) regexExtracted = clnbis;
        }

        if (
            gridPipeline &&
            brokerSubtype === 'vtb' &&
            def.id === 'operations' &&
            options.pdfBuffer
        ) {
            const clnbisOps = await extractClnbisOperationsFromBuffer(options.pdfBuffer, SECTION_DEFS);
            if (clnbisOps.ok && clnbisOps.rows.length) regexExtracted = clnbisOps;
        }

        let extracted = regexExtracted;

        if (options.pdfBuffer && gridPipeline) {
            if (brokerSubtype === 'aton' && def.id === 'operations') {
                const cashOps = await extractAtonCashOperationsFromBuffer(options.pdfBuffer, SECTION_DEFS);
                if (cashOps.ok && cashOps.rows.length) {
                    extracted = cashOps;
                } else {
                    extracted = await extractSectionTable(
                        options.pdfBuffer,
                        def,
                        SECTION_DEFS,
                        brokerSubtype,
                        {
                            regexExtract: regexExtracted,
                            fileName: options.fileName,
                            layoutFingerprint: options.layoutFingerprint,
                            pool: options.pool,
                            projectId: options.projectId,
                        }
                    );
                }
            } else if (brokerSubtype === 'aton' && def.id === 'trades') {
                const tradesGrid = await extractAtonTradesFromBuffer(options.pdfBuffer, SECTION_DEFS);
                if (tradesGrid.ok && tradesGrid.rows.length) {
                    extracted = tradesGrid;
                } else {
                    extracted = await extractSectionTable(
                        options.pdfBuffer,
                        def,
                        SECTION_DEFS,
                        brokerSubtype,
                        {
                            regexExtract: regexExtracted,
                            fileName: options.fileName,
                            layoutFingerprint: options.layoutFingerprint,
                            pool: options.pool,
                            projectId: options.projectId,
                        }
                    );
                }
            } else {
                extracted = await extractSectionTable(
                    options.pdfBuffer,
                    def,
                    SECTION_DEFS,
                    brokerSubtype,
                    {
                        regexExtract: regexExtracted,
                        fileName: options.fileName,
                        layoutFingerprint: options.layoutFingerprint,
                        pool: options.pool,
                        projectId: options.projectId,
                    }
                );
            }
        } else if (gridPipeline && (!extracted.ok || !extracted.rows.length)) {
            extracted = extractPdfTablesFromLines(slice);
        }

        if (!extracted.ok || !extracted.rows.length) continue;

        if (brokerHeaderMeta?.ok) {
            const enriched = applyAtonReportHeader(extracted.headers, extracted.rows, brokerHeaderMeta);
            extracted.headers = enriched.headers;
            extracted.rows = enriched.rows;
        }

        sections.push({
            id: def.id,
            label: def.label,
            headers: extracted.headers,
            rows: extracted.rows,
            confidence: extracted.confidence,
            method: extracted.method,
            meta: {
                ...(extracted.meta || {}),
                ...(brokerHeaderMeta?.ok
                    ? { brokerReportHeader: brokerHeaderMeta.values, atonReportHeader: brokerHeaderMeta.values }
                    : {}),
            },
        });
    }

    return sections;
}

function shouldUseMultiTableBrokerParse(sections, userMessage) {
    if (sections.length <= 1) return false;
    const filterIds = resolveSectionsFromMessage(userMessage);
    if (filterIds?.length === 1) return false;
    return sections.length >= 2;
}

module.exports = {
    SECTION_DEFS,
    isSectionAnchorRow,
    findSectionStarts,
    resolveSectionsFromMessage,
    extractBrokerPdfSectionTables,
    shouldUseMultiTableBrokerParse,
};
