const multer = require('multer');
const { validatePdfParseScenarioV3 } = require('./pdf_parse_scenario_v3_validate');
const {
    listPdfParseScenarios,
    getPdfParseScenarioById,
    savePdfParseScenario,
} = require('./universal_parse/pdf_parse_scenario_store');
const { resolvePdfParseScenario } = require('./universal_parse/resolve_pdf_parse_scenario');
const { ensureMinMarkers } = require('./universal_parse/pdf_scenario_markers');
const { probePdfKind } = require('./pdf_probe');
const {
    extractTextItems,
    clusterRows,
    extractTableGridFromPdf,
    extractTableFromRows,
    findSectionRowIndex,
} = require('./universal_parse/pdfjs_table_grid_extract');
const {
    getPdfPageMetrics,
    buildStructuralFingerprint,
} = require('./universal_parse/pdf_structural_fingerprint');
const {
    centersToNorm,
    centersFromNorm,
    xTolFromNorm,
    buildColumnsFromExtract,
} = require('./universal_parse/pdf_parse_scenario_coords');
const { diagnoseGridExtract } = require('./universal_parse/pdf_grid_diagnostics');
const { confirmPdfDraft } = require('./universal_parse/universal_parse_orchestrator');
const { extractLayoutFromScenario } = require('./universal_parse/pdf_parse_scenario_coords');
const { readInboxFileBuffer } = require('./project_inbox');
const {
    clusteredRowsForPreview,
    suggestDataStartRow,
    pageDataStartToGridDataStart,
    inferColumnCentersFromPageRows,
    inferColumnBoundaryNorms,
} = require('./universal_parse/pdf_grid_preview_utils');
const {
    extractHeaderFields,
    applyHeaderFieldsToRows,
    parseHeaderFieldsFromBody,
    suggestBrokerHeaderFields,
    validateHeaderFieldDefs,
} = require('./universal_parse/pdf_header_fields');

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const memUploadAny = memUpload.any();

function pickMulterFile(req) {
    if (req.file?.buffer?.length) return req.file;
    return (req.files || []).find((f) => f.fieldname === 'file' && f.buffer?.length) || null;
}

function resolvePdfBufferFromRequest(req) {
    const uploaded = pickMulterFile(req);
    if (uploaded?.buffer?.length) {
        return {
            buffer: uploaded.buffer,
            originalname: uploaded.originalname || 'file.pdf',
        };
    }
    const inboxPath = String(req.body?.inbox_path || req.body?.inboxPath || '').trim();
    const chatSessionId = parseInt(req.body?.chat_session_id || req.body?.chatSessionId || '0', 10);
    if (inboxPath && Number.isFinite(chatSessionId) && chatSessionId > 0) {
        try {
            const loaded = readInboxFileBuffer(
                { chatSessionId, userId: req.user?.id ?? null },
                null,
                inboxPath
            );
            if (loaded.buffer?.length) {
                return { buffer: loaded.buffer, originalname: loaded.originalname };
            }
        } catch {
            /* no file */
        }
    }
    return null;
}

function parseHeadersRowsFromBody(body = {}) {
    let headers = body.headers;
    let rows = body.rows;
    if (typeof headers === 'string') {
        headers = JSON.parse(headers || '[]');
    }
    if (typeof rows === 'string') {
        rows = JSON.parse(rows || '[]');
    }
    return { headers: headers || [], rows: rows || [] };
}

function resolvePdfBufferFromJsonBody(req) {
    const body = req.body || {};
    const inboxPath = String(body.inbox_path || body.inboxPath || '').trim();
    const chatSessionId = parseInt(body.chat_session_id || body.chatSessionId || '0', 10);
    if (inboxPath && Number.isFinite(chatSessionId) && chatSessionId > 0) {
        try {
            const loaded = readInboxFileBuffer(
                { chatSessionId, userId: req.user?.id ?? null },
                null,
                inboxPath
            );
            if (loaded.buffer?.length) {
                return { buffer: loaded.buffer, originalname: loaded.originalname };
            }
        } catch {
            /* fall through */
        }
    }
    return null;
}

function registerPdfParseConfirmRoute(router, path, middleware, { pool, maybeLinkSnapshotToChat }) {
    router.post(path, middleware, async (req, res) => {
        try {
            const file = resolvePdfBufferFromRequest(req) || resolvePdfBufferFromJsonBody(req);
            if (!file?.buffer?.length) {
                return res.status(400).json({
                    error: 'Нужен PDF в поле file или inbox_path + chat_session_id',
                });
            }
            let headers = [];
            let rows = [];
            try {
                ({ headers, rows } = parseHeadersRowsFromBody(req.body));
            } catch {
                return res.status(400).json({ error: 'headers и rows должны быть JSON' });
            }
            const result = await confirmPdfDraft(pool, {
                file: { buffer: file.buffer, originalname: file.originalname || 'file.pdf' },
                projectId: req.body?.project_id || req.body?.projectId || null,
                scenarioId: req.body?.scenario_id || req.body?.scenarioId || 'pdf_extracted',
                headers,
                rows,
                sheetName: req.body?.sheet_name || req.body?.sheetName || null,
            });
            if (!result.ok) {
                return res.status(400).json({ error: (result.errors || ['Ошибка confirm']).join('; ') });
            }
            const chatSessionId = parseInt(req.body?.chat_session_id || req.body?.chatSessionId || '', 10);
            if (maybeLinkSnapshotToChat && Number.isFinite(chatSessionId) && chatSessionId > 0 && result.snapshotId) {
                await maybeLinkSnapshotToChat({
                    chatSessionId,
                    snapshotId: result.snapshotId,
                    projectId: req.body?.project_id || req.body?.projectId || null,
                    label: file.originalname || 'PDF',
                });
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

function registerPdfParseScenarioRoutes(router, { pool, maybeLinkSnapshotToChat }) {
    router.get('/pdf-parse-scenarios', async (req, res) => {
        try {
            const rows = await listPdfParseScenarios(pool, {
                docKind: req.query.doc_kind,
                brokerSubtype: req.query.broker_subtype,
                sectionId: req.query.section_id,
                status: req.query.status || 'active',
            });
            res.json({ scenarios: rows });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/pdf-parse-scenarios/:id', async (req, res) => {
        try {
            const row = await getPdfParseScenarioById(pool, req.params.id);
            if (!row) return res.status(404).json({ error: 'Сценарий не найден' });
            res.json({ scenario: row });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-parse-scenarios', async (req, res) => {
        const { project_id, rule_json, status, parent_id, version } = req.body || {};
        let rule = rule_json;
        if (typeof rule === 'string') {
            try {
                rule = JSON.parse(rule);
            } catch {
                return res.status(400).json({ error: 'rule_json некорректен' });
            }
        }
        const validated = validatePdfParseScenarioV3(rule);
        if (!validated.ok) {
            return res.status(400).json({ error: validated.errors.join('; ') });
        }
        try {
            const saved = await savePdfParseScenario(pool, {
                projectId: project_id,
                rule: validated.rule,
                status: status || 'active',
                parentId: parent_id || null,
                version: version || 1,
            });
            if (!saved.ok) return res.status(400).json({ error: saved.errors.join('; ') });
            res.json({ scenario: saved.scenario });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-parse-scenarios/match', memUploadAny, async (req, res) => {
        try {
            const file = pickMulterFile(req);
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file' });
            }
            const pdfProbe = await probePdfKind(file.buffer, file.originalname || '');
            const resolution = await resolvePdfParseScenario(pool, file.buffer, pdfProbe, {
                sectionId: req.body?.section_id,
                forceScenarioId: req.body?.force_scenario_id || req.body?.forceScenarioId,
                fileName: file.originalname || '',
            });
            res.json(resolution);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-grid-preview', memUploadAny, async (req, res) => {
        try {
            const file = resolvePdfBufferFromRequest(req);
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file или inbox_path + chat_session_id' });
            }
            const page = parseInt(req.body?.page || '1', 10) || 1;
            const metrics = await getPdfPageMetrics(file.buffer, page);
            const anchorStart = req.body?.section_start || req.body?.anchor_start || null;

            const gridOpts = {};
            if (anchorStart) gridOpts.anchorStart = anchorStart;
            if (req.body?.section_end) gridOpts.anchorEnd = req.body.section_end;
            if (req.body?.section_id) gridOpts.sectionId = req.body.section_id;

            const grid = await extractTableGridFromPdf(file.buffer, {
                ...gridOpts,
                pageRanges: [page],
            });
            const { items } = await extractTextItems(file.buffer, [page]);
            const rows = clusterRows(items);
            const clusteredRows = clusteredRowsForPreview(
                rows,
                metrics.pageWidthPt,
                metrics.pageHeightPt
            );
            const suggestedDataStartRow = suggestDataStartRow(rows);
            const suggestedHeaderFields = suggestBrokerHeaderFields(clusteredRows);
            const suggestedHeaderFieldValues = extractHeaderFields(
                rows,
                suggestedDataStartRow,
                suggestedHeaderFields
            );

            let previewRowsOut = (grid.rows || []).slice(0, 30);
            let previewHeadersOut = grid.headers || [];
            if (suggestedHeaderFields.length && previewRowsOut.length) {
                const applied = applyHeaderFieldsToRows(
                    previewRowsOut,
                    previewHeadersOut,
                    suggestedHeaderFieldValues,
                    suggestedHeaderFields
                );
                previewRowsOut = applied.rows;
                previewHeadersOut = applied.headers;
            }

            const autoCentersRaw =
                grid.meta?.columnCenters?.length >= 2
                    ? grid.meta.columnCenters
                    : inferColumnCentersFromPageRows(rows, suggestedDataStartRow);
            const autoNorm = centersToNorm(autoCentersRaw, metrics.pageWidthPt);
            const headerColumnLeftsNorm = centersToNorm(
                inferColumnCentersFromPageRows(rows, suggestedDataStartRow),
                metrics.pageWidthPt
            );
            const columnBoundaryNorm = inferColumnBoundaryNorms(
                rows,
                suggestedDataStartRow,
                metrics.pageWidthPt
            );

            let similarScenarioCentersNorm = null;
            let similarScenarioName = null;
            let similarScenarioHeaders = null;
            let similarScenarioDataStartRow = null;
            let similarScenarioHeaderFields = null;
            if (pool) {
                try {
                    const pdfProbe = await probePdfKind(file.buffer, file.originalname || '');
                    const resolution = await resolvePdfParseScenario(pool, file.buffer, pdfProbe, {
                        projectId: req.body?.project_id,
                        sectionId: req.body?.section_id,
                    });
                    const parseSc = resolution?.parseScenario;
                    const scenarioId =
                        parseSc?.status === 'found'
                            ? parseSc.scenarioId
                            : parseSc?.candidates?.[0]?.id || null;
                    if (scenarioId && (parseSc?.status === 'found' || parseSc?.status === 'similar')) {
                        const row = await getPdfParseScenarioById(pool, scenarioId);
                        if (row?.ruleJson || row?.rule_json) {
                            const rule = row.ruleJson || row.rule_json;
                            const layout = extractLayoutFromScenario(rule, metrics.pageWidthPt);
                            if (layout.columnCenters?.length >= 2) {
                                similarScenarioCentersNorm = centersToNorm(
                                    layout.columnCenters,
                                    metrics.pageWidthPt
                                );
                                similarScenarioName = row.name || parseSc.scenarioName;
                                similarScenarioHeaders = layout.headers?.length ? layout.headers : null;
                                similarScenarioDataStartRow =
                                    layout.pageDataStartRow != null ? layout.pageDataStartRow : null;
                                similarScenarioHeaderFields = rule.header_fields?.length
                                    ? rule.header_fields
                                    : null;
                            }
                        }
                    }
                } catch {
                    /* non-fatal */
                }
            }

            res.json({
                page,
                pageWidthPt: metrics.pageWidthPt,
                pageHeightPt: metrics.pageHeightPt,
                items: items.slice(0, 800).map((it) => ({
                    text: it.text,
                    x: it.x,
                    y: it.y,
                    xNorm: it.x / metrics.pageWidthPt,
                    yNorm: it.y / metrics.pageHeightPt,
                })),
                rowCount: rows.length,
                clusteredRows,
                suggestedDataStartRow,
                suggestedHeaderFields,
                suggestedHeaderFieldValues,
                autoColumnCenters: autoCentersRaw,
                autoColumnCentersNorm: autoNorm,
                headerColumnLeftsNorm,
                columnBoundaryNorm,
                similarScenarioCentersNorm,
                similarScenarioName,
                similarScenarioHeaders,
                similarScenarioDataStartRow,
                similarScenarioHeaderFields,
                headers: previewHeadersOut,
                previewRows: previewRowsOut,
                confidence: grid.confidence || 0,
                diagnostics: diagnoseGridExtract(grid, grid.headers?.length),
                structuralFp: buildStructuralFingerprint({
                    docKind: req.body?.doc_kind || 'unknown',
                    brokerSubtype: req.body?.broker_subtype || null,
                    sectionId: req.body?.section_id || null,
                    columnCount: grid.headers?.length || 0,
                    pageWidthPt: metrics.pageWidthPt,
                    headerSample: (grid.headers || []).slice(0, 3),
                }),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-header-fields-preview', memUploadAny, async (req, res) => {
        try {
            const file = resolvePdfBufferFromRequest(req);
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file или inbox_path + chat_session_id' });
            }
            const page = parseInt(req.body?.page || '1', 10) || 1;
            const pageDataStart =
                req.body?.data_start != null
                    ? parseInt(req.body.data_start, 10)
                    : undefined;
            const headerFieldDefs = parseHeaderFieldsFromBody(req.body);
            if (!headerFieldDefs.length) {
                return res.status(400).json({ error: 'header_fields обязателен' });
            }
            const hfCheck = validateHeaderFieldDefs(headerFieldDefs);
            if (!hfCheck.ok) {
                return res.status(400).json({ error: hfCheck.errors.join('; ') });
            }
            const { items } = await extractTextItems(file.buffer, [page]);
            const clustered = clusterRows(items);
            const dataStart =
                pageDataStart != null && Number.isFinite(pageDataStart)
                    ? pageDataStart
                    : suggestDataStartRow(clustered);
            const values = extractHeaderFields(clustered, dataStart, headerFieldDefs);
            res.json({ ok: true, values, dataStartRow: dataStart });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-grid-extract', memUploadAny, async (req, res) => {
        try {
            const file = resolvePdfBufferFromRequest(req);
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file или inbox_path + chat_session_id' });
            }

            let columnCentersNorm = [];
            try {
                columnCentersNorm = JSON.parse(req.body?.column_centers_norm || '[]');
            } catch {
                return res.status(400).json({ error: 'column_centers_norm должен быть JSON-массивом' });
            }
            if (!Array.isArray(columnCentersNorm) || columnCentersNorm.length < 2) {
                return res.status(400).json({ error: 'Нужно минимум 2 колонки' });
            }

            const page = parseInt(req.body?.page || '1', 10) || 1;
            const metrics = await getPdfPageMetrics(file.buffer, page);
            const columnCenters = centersFromNorm(columnCentersNorm, metrics.pageWidthPt);
            const xTol = xTolFromNorm(parseFloat(req.body?.x_tol_norm || '0.02'), metrics.pageWidthPt);
            const pageDataStart =
                req.body?.data_start != null ? parseInt(req.body.data_start, 10) : undefined;
            const gridDataStart =
                pageDataStart != null && Number.isFinite(pageDataStart)
                    ? pageDataStartToGridDataStart(pageDataStart, 0)
                    : undefined;

            const gridOpts = {
                columnCenters,
                xTol,
                dataStart: gridDataStart,
                method: 'pdfjs_grid_manual',
                sectionId: req.body?.section_id || undefined,
                pageRanges: [page],
            };
            if (req.body?.section_start) gridOpts.anchorStart = req.body.section_start;
            if (req.body?.section_end) gridOpts.anchorEnd = req.body.section_end;

            let headers = [];
            try {
                headers = JSON.parse(req.body?.headers || '[]');
            } catch {
                headers = [];
            }
            if (headers.length) gridOpts.visionHeaders = headers;

            const grid = await extractTableGridFromPdf(file.buffer, gridOpts);
            const diagnostics = diagnoseGridExtract(grid, columnCentersNorm.length);

            const headerFieldDefs = parseHeaderFieldsFromBody(req.body);
            let outHeaders = grid.headers || [];
            let outRows = grid.rows || [];
            let headerFieldValues = {};
            if (headerFieldDefs.length) {
                const { items } = await extractTextItems(file.buffer, [page]);
                const clustered = clusterRows(items);
                const pageStart =
                    pageDataStart != null && Number.isFinite(pageDataStart)
                        ? pageDataStart
                        : suggestDataStartRow(clustered);
                headerFieldValues = extractHeaderFields(clustered, pageStart, headerFieldDefs);
                const applied = applyHeaderFieldsToRows(
                    outRows,
                    outHeaders,
                    headerFieldValues,
                    headerFieldDefs
                );
                outHeaders = applied.headers;
                outRows = applied.rows;
            }

            res.json({
                ok: grid.ok,
                headers: outHeaders,
                rows: outRows,
                rowCount: outRows.length,
                confidence: diagnostics.confidence,
                diagnostics,
                meta: grid.meta,
                headerFieldValues,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-parse-scenarios/from-extract', async (req, res) => {
        const {
            name,
            doc_kind,
            broker_subtype,
            section_id,
            description,
            tags,
            page_width_pt,
            column_centers_norm,
            headers,
            x_tol_norm,
            data_start_row,
            header_row_count,
            markers,
            section_start,
            section_end,
            expected_row_count,
            header_fields,
            probe_header_sample,
            text_snippet,
            filename,
        } = req.body || {};

        if (!name || !Array.isArray(column_centers_norm) || column_centers_norm.length < 2) {
            return res.status(400).json({ error: 'name и column_centers_norm (>=2) обязательны' });
        }

        const hdrs = Array.isArray(headers) ? headers : column_centers_norm.map((_, i) => `col_${i + 1}`);
        const pageW = Number(page_width_pt) || 595.28;
        const centers = centersFromNorm(column_centers_norm, pageW);

        const headerFieldDefs = Array.isArray(header_fields) ? header_fields : [];
        if (headerFieldDefs.length) {
            const hfCheck = validateHeaderFieldDefs(headerFieldDefs);
            if (!hfCheck.ok) {
                return res.status(400).json({ error: hfCheck.errors.join('; ') });
            }
        }

        const probeHeaders = Array.isArray(probe_header_sample)
            ? probe_header_sample.filter(Boolean).slice(0, 3)
            : hdrs.slice(0, 3);
        const finalMarkers = ensureMinMarkers(markers, text_snippet || '', {
            headers: probeHeaders,
            filename,
        });
        if (finalMarkers.length < 2) {
            return res.status(400).json({
                error: 'Нужно минимум 2 detection marker — добавь ключевые слова из текста PDF',
            });
        }

        const structuralFpAtSave = buildStructuralFingerprint({
            docKind: doc_kind || 'unknown',
            brokerSubtype: broker_subtype || null,
            sectionId: section_id || null,
            columnCount: hdrs.length,
            pageWidthPt: pageW,
            headerSample: probeHeaders,
        });

        const tagList = Array.isArray(tags)
            ? tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 12)
            : typeof tags === 'string'
              ? tags
                    .split(/[,;]+/)
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .slice(0, 12)
              : [];

        const rule = {
            rule_schema_version: 3,
            meta: {
                name,
                source_type: 'pdf',
                doc_kind: doc_kind || 'unknown',
                broker_subtype: broker_subtype || null,
                section_id: section_id || null,
                description: description || '',
                tags: tagList,
            },
            detection: {
                markers: finalMarkers,
                min_marker_hits: 1,
                probe_at_save: {
                    structural_fp: structuralFpAtSave,
                    header_sample: probeHeaders,
                    column_count: hdrs.length,
                    text_snippet: String(text_snippet || '').slice(0, 500),
                    filename_pattern: filename ? String(filename).slice(0, 120) : null,
                },
            },
            layout: {
                engine: 'pdfjs_grid',
                section_start: section_start ? { pattern: section_start, match: 'row' } : undefined,
                section_end: section_end ? { pattern: section_end, match: 'row' } : undefined,
                page_width_pt: pageW,
                data_start_row: data_start_row ?? 0,
                header_row_count: header_row_count ?? 0,
                x_tol_norm: Number(x_tol_norm) || 0.02,
            },
            columns: buildColumnsFromExtract(hdrs, centers, pageW),
            ...(headerFieldDefs.length ? { header_fields: headerFieldDefs } : {}),
            validation: {
                expected_column_count: hdrs.length,
                expected_row_count: expected_row_count ?? null,
            },
        };

        try {
            const saved = await savePdfParseScenario(pool, {
                rule,
                status: 'active',
            });
            if (!saved.ok) return res.status(400).json({ error: saved.errors.join('; ') });
            console.log(
                `[pdf-scenario] saved id=${saved.scenario?.id} name=${JSON.stringify(saved.scenario?.name)} markers=${(rule.detection?.markers || []).length}`
            );
            res.json({ scenario: saved.scenario });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    registerPdfParseConfirmRoute(router, '/pdf-parse-confirm', memUploadAny, {
        pool,
        maybeLinkSnapshotToChat,
    });
    registerPdfParseConfirmRoute(router, '/pdf-parse-scenarios/confirm', memUploadAny, {
        pool,
        maybeLinkSnapshotToChat,
    });
    router.post('/pdf-parse-scenarios/confirm-draft', async (req, res) => {
        try {
            const file = resolvePdfBufferFromJsonBody(req) || resolvePdfBufferFromRequest(req);
            if (!file?.buffer?.length) {
                return res.status(400).json({
                    error: 'Нужен inbox_path + chat_session_id (или file в multipart)',
                });
            }
            let headers = [];
            let rows = [];
            try {
                ({ headers, rows } = parseHeadersRowsFromBody(req.body));
            } catch {
                return res.status(400).json({ error: 'headers и rows должны быть JSON' });
            }
            const result = await confirmPdfDraft(pool, {
                file: { buffer: file.buffer, originalname: file.originalname || 'file.pdf' },
                projectId: req.body?.project_id || req.body?.projectId || null,
                scenarioId: req.body?.scenario_id || req.body?.scenarioId || 'pdf_extracted',
                headers,
                rows,
                sheetName: req.body?.sheet_name || req.body?.sheetName || null,
            });
            if (!result.ok) {
                return res.status(400).json({ error: (result.errors || ['Ошибка confirm']).join('; ') });
            }
            const chatSessionId = parseInt(req.body?.chat_session_id || req.body?.chatSessionId || '', 10);
            if (maybeLinkSnapshotToChat && Number.isFinite(chatSessionId) && chatSessionId > 0 && result.snapshotId) {
                await maybeLinkSnapshotToChat({
                    chatSessionId,
                    snapshotId: result.snapshotId,
                    projectId: req.body?.project_id || req.body?.projectId || null,
                    label: file.originalname || 'PDF',
                });
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { registerPdfParseScenarioRoutes };
