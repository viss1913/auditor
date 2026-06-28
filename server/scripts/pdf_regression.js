/**
 * Regression: golden PDF → probe + auto-grid extract.
 * Usage: node server/scripts/pdf_regression.js
 */
const fs = require('fs');
const path = require('path');
const { buildPdfProbeWords } = require('../universal_parse/pdf_probe_words');
const { extractTableGridFromPdf } = require('../universal_parse/pdfjs_table_grid_extract');
const { ISIN_RE } = require('../universal_parse/pdf_row_scoring');

const manifestPath = path.join(__dirname, '../tests/golden_dataset/manifest.json');

async function runCase(entry, manifestParserVersion) {
    const pdfPath = path.resolve(path.join(__dirname, entry.file));
    if (!fs.existsSync(pdfPath)) {
        return { id: entry.id, skip: true, reason: `missing ${pdfPath}` };
    }
    const buffer = fs.readFileSync(pdfPath);
    const page = entry.page || 1;

    const probe = await buildPdfProbeWords(buffer, { page, documentId: entry.id });
    const grid = await extractTableGridFromPdf(buffer, { pageRanges: [page] });

    const warnings = [];
    if (!probe.logical_rows?.length) warnings.push('probe: no logical_rows');
    if (!grid.ok) warnings.push(`grid: ${grid.reason || 'not ok'}`);

    const rowCount = grid.rows?.length || 0;
    const colCount = grid.headers?.length || 0;
    if (rowCount < (entry.min_rows || 1)) {
        warnings.push(`rows ${rowCount} < min ${entry.min_rows}`);
    }
    if (colCount < (entry.min_columns || 2)) {
        warnings.push(`cols ${colCount} < min ${entry.min_columns}`);
    }
    if (entry.expect_isin) {
        const joined = (grid.rows || []).map((r) => Object.values(r).join(' ')).join('\n');
        if (!ISIN_RE.test(joined)) warnings.push('expected ISIN not found');
    }
    if (entry.min_confidence != null && grid.confidence != null && grid.confidence < entry.min_confidence) {
        warnings.push(`confidence ${grid.confidence} < min ${entry.min_confidence}`);
    }
    if (probe.parser_version && manifestParserVersion && probe.parser_version !== manifestParserVersion) {
        warnings.push(`parser_version ${probe.parser_version} != ${manifestParserVersion}`);
    }
    if (entry.min_logical_rows != null && (probe.logical_row_count ?? probe.logical_rows?.length ?? 0) < entry.min_logical_rows) {
        warnings.push(`logical_rows below min ${entry.min_logical_rows}`);
    }

    return {
        id: entry.id,
        ok: warnings.length === 0,
        rowCount,
        colCount,
        parser_version: probe.parser_version,
        logical_row_count: probe.logical_row_count ?? probe.logical_rows?.length ?? 0,
        suggested_data_start_row: probe.suggested_data_start_row,
        confidence: grid.confidence ?? null,
        warnings,
    };
}

async function main() {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifestParserVersion = manifest.parser_version || null;
    const results = [];
    for (const entry of manifest.cases || []) {
        results.push(await runCase(entry, manifestParserVersion));
    }

    let failed = 0;
    let skipped = 0;
    for (const r of results) {
        if (r.skip) {
            skipped += 1;
            console.log(`SKIP ${r.id}: ${r.reason}`);
            continue;
        }
        if (r.ok) {
            console.log(
                `OK   ${r.id}: rows=${r.rowCount} cols=${r.colCount} start=${r.suggested_data_start_row} ${r.parser_version}`
            );
        } else {
            failed += 1;
            console.error(`FAIL ${r.id}:`, r.warnings.join('; '));
        }
    }

    if (failed > 0) process.exit(1);
    if (skipped === results.length) {
        console.warn('All cases skipped — PDF fixtures missing?');
        process.exit(0);
    }
    console.log(`pdf_regression: ${results.length - skipped - failed} passed, ${skipped} skipped`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
