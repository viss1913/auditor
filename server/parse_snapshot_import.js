const { runParseFull, withTempFile, PREVIEW_ROWS_CLIENT } = require('./parse_preview');
const { createParseSnapshotStore } = require('./parse_snapshot_store');

/**
 * Полный парс файла → Postgres snapshot + урезанный preview для клиента.
 */
async function importFileToSnapshot(pool, {
    fileBuffer,
    fileName,
    rule,
    projectId = null,
    sheetName = null,
    scenarioId = null,
    ruleId = null,
}) {
    const store = createParseSnapshotStore(pool);
    const snapshotId = await store.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: fileName,
        sheetName,
        scenarioId,
        ruleId,
        headers: [],
        status: 'parsing',
    });

    try {
        const parseResult = withTempFile(fileBuffer, fileName, (tmpPath) => runParseFull(tmpPath, rule));
        if (!parseResult.ok) {
            await store.setSnapshotStatus(snapshotId, 'failed', {
                errorMessage: parseResult.errors.join('; '),
            });
            return {
                ok: false,
                snapshotId,
                errors: parseResult.errors,
                warnings: [],
            };
        }

        const rowCount = await store.importParsedRows(
            snapshotId,
            parseResult.headers,
            parseResult.rows
        );

        const previewRows = parseResult.rows.slice(0, PREVIEW_ROWS_CLIENT);
        return {
            ok: true,
            snapshotId,
            parsePreview: {
                headers: parseResult.headers,
                rows: previewRows,
                rowCount,
            },
            warnings: parseResult.warnings || [],
            rule: parseResult.rule,
        };
    } catch (err) {
        await store.setSnapshotStatus(snapshotId, 'failed', { errorMessage: err.message });
        throw err;
    }
}

module.exports = { importFileToSnapshot, PREVIEW_ROWS_CLIENT };
