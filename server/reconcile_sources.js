const path = require('path');
const { collectAllInboxEntries, parseInboxScope, normalizeStoredRelativePath } = require('./project_inbox');
const { parseInboxFileToTable } = require('./reconcile_inbox_parse');
const { collectSnapshotRows } = require('./snapshot_export');

const SOURCE_REF_RE = /^(snapshot|inbox|active):(.+)$/i;

function parseSourceRef(ref) {
    const raw = String(ref || '').trim();
    const m = raw.match(SOURCE_REF_RE);
    if (m) {
        return { type: m[1].toLowerCase(), id: m[2].trim() };
    }
    if (/^\d+$/.test(raw)) return { type: 'snapshot', id: raw };
    if (raw) return { type: 'inbox', id: raw };
    return null;
}

function formatSourceRef(type, id) {
    return `${type}:${id}`;
}

function findInboxEntry(auditorSlug, projectId, relativePath) {
    const rel = normalizeStoredRelativePath(relativePath);
    const entries = collectAllInboxEntries(auditorSlug, projectId);
    return entries.find((e) => e.relativePath === rel) || null;
}

async function loadSnapshotTable(store, snapshotId) {
    const collected = await collectSnapshotRows(store, snapshotId);
    if (!collected) return null;
    const { snap, headers, rows } = collected;
    return {
        headers,
        rows,
        label:
            snap.sourceFileName ||
            (snap.sheetName ? `${snap.sourceFileName || 'таблица'} · ${snap.sheetName}` : `snapshot #${snap.id}`),
        meta: { snapshotId: snap.id, scenarioId: snap.scenarioId, tableMeta: snap.tableMeta || null },
    };
}

async function loadInboxTable(auditorSlug, projectId, relativePath, { ephemeralCache } = {}) {
    const rel = normalizeStoredRelativePath(relativePath);
    const cacheKey = `${auditorSlug}:${projectId}:${rel}`;
    if (ephemeralCache?.has(cacheKey)) return ephemeralCache.get(cacheKey);

    const entry = findInboxEntry(auditorSlug, projectId, rel);
    if (!entry?.absolutePath) {
        throw new Error(`Файл не найден в хранилище проекта: ${rel}`);
    }
    const table = parseInboxFileToTable(entry.absolutePath, entry.name);
    table.label = entry.name || rel;
    table.meta = { inboxPath: rel, ephemeral: true };
    if (ephemeralCache) ephemeralCache.set(cacheKey, table);
    return table;
}

async function resolveDataSource(store, source, ctx) {
    const parsed = typeof source === 'string' ? parseSourceRef(source) : source;
    if (!parsed) throw new Error('Не указан источник данных для сверки');

    if (parsed.type === 'snapshot' || parsed.type === 'active') {
        const sid = parseInt(parsed.id, 10);
        if (!Number.isFinite(sid)) throw new Error(`Некорректный snapshot: ${parsed.id}`);
        const table = await loadSnapshotTable(store, sid);
        if (!table) throw new Error(`Snapshot #${sid} не найден`);
        return table;
    }

    if (parsed.type === 'inbox') {
        const auditorSlug = ctx.auditorSlug || 'martin';
        const projectId = ctx.projectId;
        if (!projectId) throw new Error('Для файла из inbox нужен projectId');
        return loadInboxTable(auditorSlug, projectId, parsed.id, {
            ephemeralCache: ctx.ephemeralCache,
        });
    }

    throw new Error(`Неизвестный тип источника: ${parsed.type}`);
}

async function resolvePlanSources(store, plan, ctx) {
    const leftRef = plan.left?.ref || plan.leftRef || plan.leftSnapshotId;
    const rightRef = plan.right?.ref || plan.rightRef || plan.rightSnapshotId;

    const left = await resolveDataSource(
        store,
        leftRef != null && /^\d+$/.test(String(leftRef))
            ? formatSourceRef('snapshot', leftRef)
            : leftRef || plan.left,
        ctx
    );
    const right = await resolveDataSource(
        store,
        rightRef != null && /^\d+$/.test(String(rightRef))
            ? formatSourceRef('snapshot', rightRef)
            : rightRef || plan.right,
        ctx
    );

    let broker = null;
    let depo = null;
    if (plan.broker?.ref) {
        broker = await resolveDataSource(store, plan.broker.ref, ctx);
    }
    if (plan.depo?.ref) {
        depo = await resolveDataSource(store, plan.depo.ref, ctx);
    }

    return { left, right, broker, depo };
}

module.exports = {
    parseSourceRef,
    formatSourceRef,
    findInboxEntry,
    loadSnapshotTable,
    loadInboxTable,
    resolveDataSource,
    resolvePlanSources,
};
