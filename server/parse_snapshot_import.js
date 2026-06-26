const { runParseFull, withTempFile } = require('./parse_preview');
const { CLIENT_PREVIEW_ROWS } = require('./client_response_sanitize');
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
    parseResult = null,
    sheetLoad = null,
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
        let parsed = parseResult;
        if (!parsed?.ok) {
            const engineOpts = sheetLoad ? { sheetLoad } : {};
            parsed = sheetLoad
                ? runParseFull(null, rule, engineOpts)
                : withTempFile(fileBuffer, fileName, (tmpPath) => runParseFull(tmpPath, rule));
        }
        if (!parsed.ok) {
            await store.setSnapshotStatus(snapshotId, 'failed', {
                errorMessage: parsed.errors.join('; '),
            });
            return {
                ok: false,
                snapshotId,
                errors: parsed.errors,
                warnings: [],
            };
        }

        const rowCount = await store.importParsedRows(
            snapshotId,
            parsed.headers,
            parsed.rows
        );

        const previewRows = parsed.rows.slice(0, CLIENT_PREVIEW_ROWS);
        return {
            ok: true,
            snapshotId,
            parsePreview: {
                ok: true,
                headers: parsed.headers,
                rows: previewRows,
                rowCount,
            },
            warnings: parsed.warnings || [],
            rule: parsed.rule,
        };
    } catch (err) {
        await store.setSnapshotStatus(snapshotId, 'failed', { errorMessage: err.message });
        throw err;
    }
}

module.exports = { importFileToSnapshot, PREVIEW_ROWS_CLIENT: CLIENT_PREVIEW_ROWS };
