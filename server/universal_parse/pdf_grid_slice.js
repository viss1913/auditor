const { centersFromNorm, xTolFromNorm } = require('./pdf_parse_scenario_coords');
const { pageDataStartToGridDataStart } = require('./pdf_grid_preview_utils');
const { extractTableGridFromPdf } = require('./pdfjs_table_grid_extract');
const { diagnoseGridExtract } = require('./pdf_grid_diagnostics');
const { PARSER_VERSION } = require('./pdf_probe_words');
const { computeQualityScore } = require('./pdf_scenario_quality');

/**
 * Backend source of truth: re-slice PDF by column settings.
 */
async function extractGridBySettings(buffer, settings = {}) {
    const page = parseInt(settings.page || '1', 10) || 1;
    const columnCentersNorm = settings.column_centers_norm || settings.columnCentersNorm || [];
    const pageW = Number(settings.page_width_pt || settings.pageWidthPt || 595.28);
    const columnCenters = centersFromNorm(columnCentersNorm, pageW);
    const xTol = xTolFromNorm(parseFloat(settings.x_tol_norm || '0.02'), pageW);

    const pageDataStart =
        settings.data_start_row != null
            ? parseInt(settings.data_start_row, 10)
            : settings.dataStartRow != null
              ? parseInt(settings.dataStartRow, 10)
              : undefined;

    let gridDataStart;
    if (pageDataStart != null && Number.isFinite(pageDataStart) && pageDataStart > 0) {
        gridDataStart = pageDataStartToGridDataStart(pageDataStart, 0);
    }

    const headers = settings.headers || settings.visionHeaders || [];
    const grid = await extractTableGridFromPdf(buffer, {
        columnCenters,
        xTol,
        dataStart: gridDataStart,
        method: 'pdfjs_grid_manual',
        visionHeaders: headers,
        pageRanges: [page],
        sectionId: settings.section_id || settings.sectionId,
        anchorStart: settings.section_start || settings.sectionStart,
        anchorEnd: settings.section_end || settings.sectionEnd,
    });

    const diagnostics = diagnoseGridExtract(grid, columnCentersNorm.length);
    return {
        ok: grid.ok,
        headers: grid.headers || [],
        rows: grid.rows || [],
        confidence: diagnostics.confidence ?? grid.confidence ?? 0,
        warnings: diagnostics.warnings || [],
        diagnostics,
        meta: {
            ...(grid.meta || {}),
            parser_version: PARSER_VERSION,
            extract_method: 'pdfjs_grid_manual',
        },
    };
}

function buildSnapshotMeta(extractResult, settings = {}, quality = {}) {
    return {
        parser_version: PARSER_VERSION,
        scenario_id: settings.scenario_id || settings.scenarioId || null,
        scenario_version: settings.scenario_version || settings.scenarioVersion || null,
        column_centers_norm: settings.column_centers_norm || settings.columnCentersNorm || [],
        data_start_row: settings.data_start_row ?? settings.dataStartRow ?? null,
        quality_score: quality.quality_score ?? null,
        warnings: extractResult.warnings || [],
        extract_method: extractResult.meta?.extract_method || 'pdfjs_grid_manual',
        frontend_preview_hash: settings.frontend_preview_hash || null,
    };
}

async function extractWithQuality(buffer, settings, scenarioRow, signals) {
    const extractResult = await extractGridBySettings(buffer, settings);
    const quality = computeQualityScore({
        signals: signals || {},
        scenarioRow,
        gridTable: extractResult,
    });
    return { ...extractResult, quality };
}

module.exports = {
    extractGridBySettings,
    extractWithQuality,
    buildSnapshotMeta,
};
