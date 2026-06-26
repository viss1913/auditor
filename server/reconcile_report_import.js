const { inferTableMeta } = require('./table_meta');
const { updateSnapshotHeaders } = require('./parse_snapshot_operations');
const { DEPO_AUDIT_COLUMNS } = require('./opif_legacy_audit');

async function importReportSnapshot(store, {
    projectId = null,
    plan,
    leftLabel,
    rightLabel,
    reconcileResult,
    title: titleOverride = null,
}) {
    const headers = reconcileResult.headers || [];
    const rows = (reconcileResult.rows || []).map((row) => {
        const copy = { ...row };
        if (Array.isArray(copy._reconcile_mismatch_columns) && copy._reconcile_mismatch_columns.length) {
            copy._reconcile_mismatch_columns = [...copy._reconcile_mismatch_columns];
        }
        return copy;
    });

    const title =
        titleOverride ||
        `${plan?.reportLabel || 'Сверка'}: ${leftLabel || 'A'} ↔ ${rightLabel || 'B'}`;
    const tableMeta = {
        ...inferTableMeta(headers, 'reconcile_report'),
        reconcileReport: true,
        reportMode: reconcileResult.summary?.reportMode || plan?.join || 'outer',
        auditScenarioId: plan?.auditScenarioId || reconcileResult.summary?.auditScenarioId || null,
        plan: plan || null,
        leftSource: leftLabel || plan?.left?.label || '',
        rightSource: rightLabel || plan?.right?.label || '',
        summary: reconcileResult.summary || {},
    };

    const snapshotId = await store.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: title,
        sheetName: 'Сверка',
        scenarioId: 'reconcile_report',
        headers,
        tableMeta,
        status: 'parsing',
    });

    const rowCount = await store.importParsedRows(snapshotId, headers, rows);
    return {
        snapshotId,
        rowCount,
        headers,
        tableMeta,
        title,
        summary: reconcileResult.summary,
    };
}

/**
 * Дополнить существующий snapshot отчёта аудита колонками ДЕПО (in-place).
 */
async function enrichAuditSnapshotInPlace(store, {
    snapshotId,
    reconcileResult,
    plan,
    depoLabel = '',
}) {
    const snap = await store.getSnapshot(snapshotId);
    if (!snap) throw new Error(`Snapshot #${snapshotId} не найден`);

    const newHeaders = reconcileResult.headers || snap.headers || [];
    const patchCols = [...DEPO_AUDIT_COLUMNS, 'reconcile_status'];

    const updates = (reconcileResult.rows || []).map((row, rowIndex) => {
        const patch = {};
        for (const col of patchCols) {
            if (row[col] !== undefined) patch[col] = row[col];
        }
        return { rowIndex, patch };
    });
    if (updates.length) {
        await store.updateRowsBatch(snapshotId, updates);
    }

    if (newHeaders.length) {
        await updateSnapshotHeaders(store.pool, snapshotId, newHeaders);
    }

    const mergedMeta = {
        ...(snap.tableMeta || {}),
        reconcileReport: true,
        auditScenarioId: plan?.auditScenarioId || 'opif_enrich_depo',
        enrichedDepo: true,
        depoSource: depoLabel || plan?.right?.label || '',
        summary: {
            ...(snap.tableMeta?.summary || {}),
            ...(reconcileResult.summary || {}),
        },
        plan: plan || snap.tableMeta?.plan || null,
    };

    await store.pool.query(`UPDATE parse_snapshots SET table_meta = $2::jsonb WHERE id = $1`, [
        snapshotId,
        JSON.stringify(mergedMeta),
    ]);

    return {
        snapshotId,
        rowCount: snap.rowCount,
        headers: newHeaders,
        tableMeta: mergedMeta,
        title: snap.sourceFileName,
        summary: reconcileResult.summary,
        enrichedInPlace: true,
    };
}

module.exports = { importReportSnapshot, enrichAuditSnapshotInPlace };
