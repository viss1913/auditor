const multer = require('multer');
const { validatePdfParseScenarioV3 } = require('./pdf_parse_scenario_v3_validate');
const {
    listPdfParseScenarios,
    getPdfParseScenarioById,
    savePdfParseScenario,
} = require('./universal_parse/pdf_parse_scenario_store');
const { resolvePdfParseScenario } = require('./universal_parse/resolve_pdf_parse_scenario');
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

const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function registerPdfParseScenarioRoutes(router, { pool }) {
    router.get('/pdf-parse-scenarios', async (req, res) => {
        try {
            const rows = await listPdfParseScenarios(pool, {
                projectId: req.query.project_id,
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

    router.post('/pdf-parse-scenarios/match', memUpload.single('file'), async (req, res) => {
        try {
            const file = req.file;
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file' });
            }
            const pdfProbe = await probePdfKind(file.buffer, file.originalname || '');
            const resolution = await resolvePdfParseScenario(pool, file.buffer, pdfProbe, {
                projectId: req.body?.project_id,
                sectionId: req.body?.section_id,
            });
            res.json(resolution);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-grid-preview', memUpload.single('file'), async (req, res) => {
        try {
            const file = req.file;
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file' });
            }
            const page = parseInt(req.body?.page || '1', 10) || 1;
            const metrics = await getPdfPageMetrics(file.buffer, page);
            const anchorStart = req.body?.section_start || req.body?.anchor_start || null;

            const gridOpts = {};
            if (anchorStart) gridOpts.anchorStart = anchorStart;
            if (req.body?.section_end) gridOpts.anchorEnd = req.body.section_end;
            if (req.body?.section_id) gridOpts.sectionId = req.body.section_id;

            const grid = await extractTableGridFromPdf(file.buffer, gridOpts);
            const { items } = await extractTextItems(file.buffer, [page]);
            const rows = clusterRows(items);

            const autoNorm = centersToNorm(grid.meta?.columnCenters || [], metrics.pageWidthPt);

            let similarScenarioCentersNorm = null;
            let similarScenarioName = null;
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
                            const layout = extractLayoutFromScenario(
                                row.ruleJson || row.rule_json,
                                metrics.pageWidthPt
                            );
                            if (layout.columnCenters?.length >= 2) {
                                similarScenarioCentersNorm = centersToNorm(
                                    layout.columnCenters,
                                    metrics.pageWidthPt
                                );
                                similarScenarioName = row.name || parseSc.scenarioName;
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
                autoColumnCenters: grid.meta?.columnCenters || [],
                autoColumnCentersNorm: autoNorm,
                similarScenarioCentersNorm,
                similarScenarioName,
                headers: grid.headers || [],
                previewRows: (grid.rows || []).slice(0, 30),
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

    router.post('/pdf-grid-extract', memUpload.single('file'), async (req, res) => {
        try {
            const file = req.file;
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file' });
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

            const metrics = await getPdfPageMetrics(file.buffer, 1);
            const columnCenters = centersFromNorm(columnCentersNorm, metrics.pageWidthPt);
            const xTol = xTolFromNorm(parseFloat(req.body?.x_tol_norm || '0.02'), metrics.pageWidthPt);
            const dataStart = req.body?.data_start != null ? parseInt(req.body.data_start, 10) : undefined;

            const gridOpts = {
                columnCenters,
                xTol,
                dataStart,
                method: 'pdfjs_grid_manual',
                sectionId: req.body?.section_id || undefined,
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

            res.json({
                ok: grid.ok,
                headers: grid.headers,
                rows: grid.rows,
                rowCount: grid.rows?.length || 0,
                confidence: diagnostics.confidence,
                diagnostics,
                meta: grid.meta,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-parse-scenarios/from-extract', async (req, res) => {
        const {
            project_id,
            name,
            doc_kind,
            broker_subtype,
            section_id,
            description,
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
        } = req.body || {};

        if (!name || !Array.isArray(column_centers_norm) || column_centers_norm.length < 2) {
            return res.status(400).json({ error: 'name и column_centers_norm (>=2) обязательны' });
        }

        const hdrs = Array.isArray(headers) ? headers : column_centers_norm.map((_, i) => `col_${i + 1}`);
        const pageW = Number(page_width_pt) || 595.28;
        const centers = centersFromNorm(column_centers_norm, pageW);

        const rule = {
            rule_schema_version: 3,
            meta: {
                name,
                source_type: 'pdf',
                doc_kind: doc_kind || 'unknown',
                broker_subtype: broker_subtype || null,
                section_id: section_id || null,
                description: description || '',
            },
            detection: {
                markers: Array.isArray(markers) ? markers : [],
                min_marker_hits: 1,
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
            validation: {
                expected_column_count: hdrs.length,
                expected_row_count: expected_row_count ?? null,
            },
        };

        try {
            const saved = await savePdfParseScenario(pool, {
                projectId: project_id,
                rule,
                status: 'active',
            });
            if (!saved.ok) return res.status(400).json({ error: saved.errors.join('; ') });
            res.json({ scenario: saved.scenario });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/pdf-parse-confirm', memUpload.single('file'), async (req, res) => {
        try {
            const file = req.file;
            if (!file?.buffer?.length) {
                return res.status(400).json({ error: 'Нужен PDF в поле file' });
            }
            let headers = [];
            let rows = [];
            try {
                headers = JSON.parse(req.body?.headers || '[]');
                rows = JSON.parse(req.body?.rows || '[]');
            } catch {
                return res.status(400).json({ error: 'headers и rows должны быть JSON' });
            }
            const result = await confirmPdfDraft(pool, {
                file,
                projectId: req.body?.project_id || req.body?.projectId || null,
                scenarioId: req.body?.scenario_id || req.body?.scenarioId || 'pdf_extracted',
                headers,
                rows,
                sheetName: req.body?.sheet_name || req.body?.sheetName || null,
            });
            if (!result.ok) {
                return res.status(400).json({ error: (result.errors || ['Ошибка confirm']).join('; ') });
            }
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { registerPdfParseScenarioRoutes };
