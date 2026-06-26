const { collectAllInboxEntries } = require('./project_inbox');
const { loadSnapshotTable } = require('./reconcile_sources');
const { formatSourceRef } = require('./reconcile_sources');

const SAMPLE_ROWS = 5;

function sampleRows(rows, limit = SAMPLE_ROWS) {
    return (rows || []).slice(0, limit);
}

async function buildSnapshotCatalogEntry(store, snapLink) {
    const table = await loadSnapshotTable(store, snapLink.snapshotId);
    if (!table) return null;
    const tableMeta = table.meta?.tableMeta || snapLink.tableMeta || {};
    const headers = table.headers || [];
    return {
        ref: formatSourceRef('snapshot', snapLink.snapshotId),
        type: 'snapshot',
        snapshotId: snapLink.snapshotId,
        label: snapLink.label || table.label || `Таблица #${snapLink.snapshotId}`,
        sourceFileName: snapLink.sourceFileName || table.meta?.sourceFileName || null,
        sheetName: snapLink.sheetName || null,
        rowCount: snapLink.rowCount ?? table.rows.length,
        scenarioId: snapLink.scenarioId || table.meta?.scenarioId || tableMeta.scenarioId || null,
        headers,
        sampleRows: sampleRows(table.rows),
        reconcileReport: !!tableMeta.reconcileReport,
        auditScenarioId: tableMeta.auditScenarioId || null,
        hasBrokerAudit: headers.includes('brokerFound'),
    };
}

function buildInboxCatalogEntry(entry) {
    return {
        ref: formatSourceRef('inbox', entry.relativePath),
        type: 'inbox',
        relativePath: entry.relativePath,
        label: entry.name || entry.relativePath,
        kind: entry.kind,
        rowCount: null,
        headers: [],
        sampleRows: [],
        needsParse: true,
    };
}

async function buildReconcileCatalog({
    store,
    chatSessionStore,
    auditorSlug,
    projectId,
    chatSessionId,
    activeSnapshotId,
}) {
    const snapshots = [];
    if (chatSessionId) {
        const links = await chatSessionStore.listChatSnapshots(chatSessionId);
        for (const link of links) {
            if (link.status !== 'ready') continue;
            const entry = await buildSnapshotCatalogEntry(store, link);
            if (entry) snapshots.push(entry);
        }
    }

    const inboxFiles = projectId
        ? collectAllInboxEntries(auditorSlug || 'martin', projectId).map(buildInboxCatalogEntry)
        : [];

    const byRef = new Map();
    for (const s of snapshots) byRef.set(s.ref, s);
    for (const f of inboxFiles) {
        if (!byRef.has(f.ref)) byRef.set(f.ref, f);
    }

    return {
        sources: [...byRef.values()],
        activeSnapshotId: activeSnapshotId || null,
        projectId: projectId || null,
    };
}

module.exports = {
    buildReconcileCatalog,
    buildSnapshotCatalogEntry,
    buildInboxCatalogEntry,
    sampleRows,
};
