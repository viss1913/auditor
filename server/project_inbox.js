const fs = require('fs');
const path = require('path');
const { probeFileList } = require('./opif_martin');

const SOURCE_KINDS = ['broker', 'uk', 'depo', 'other'];
const WORKSPACE_SUBDIR = 'workspace';
const INBOX_ROOT = process.env.AUDITOR_INBOX_ROOT
    ? path.resolve(process.env.AUDITOR_INBOX_ROOT)
    : path.join(__dirname, 'data', 'inbox');

const BROKER_EXTS = new Set(['.xls', '.xlsx', '.xlsm']);
const PDF_EXTS = new Set(['.pdf']);

function parseInboxScope(a, b) {
    if (a != null && typeof a === 'object') {
        if (a.chatSessionId != null) {
            const id = parseInt(a.chatSessionId, 10);
            const userPart =
                a.userId != null
                    ? path.join('users', `user-${parseInt(a.userId, 10)}`)
                    : path.join('martin');
            return {
                mode: 'chat',
                chatSessionId: id,
                userId: a.userId != null ? parseInt(a.userId, 10) : null,
                root: path.join(INBOX_ROOT, userPart, 'chats', `chat-${id}`),
                label: `chat #${id}`,
            };
        }
        const userPart =
            a.userId != null
                ? path.join('users', `user-${parseInt(a.userId, 10)}`)
                : String(a.auditorSlug || 'martin');
        return {
            mode: 'project',
            auditorSlug: String(a.auditorSlug || 'martin'),
            projectId: a.projectId,
            userId: a.userId != null ? parseInt(a.userId, 10) : null,
            root: path.join(INBOX_ROOT, userPart, `project-${a.projectId}`),
            label: `${userPart}/project-${a.projectId}`,
        };
    }
    return {
        mode: 'project',
        auditorSlug: String(a),
        projectId: b,
        root: path.join(INBOX_ROOT, String(a), `project-${b}`),
        label: `${a}/project-${b}`,
    };
}

function sanitizeClientRelativePath(rel) {
    let n = String(rel || '').replace(/\\/g, '/').trim();
    n = n.replace(/^\.\//, '');
    n = n.replace(/^[a-zA-Z]:\//, '');
    // На Windows path.isAbsolute('/folder') === true — для inbox это всё равно относительный путь
    n = n.replace(/^\/+/, '');
    return n;
}

function assertSafeRelative(rel) {
    const n = sanitizeClientRelativePath(rel);
    if (!n) {
        throw new Error('Недопустимый путь файла');
    }
    const segments = n.split('/').filter(Boolean);
    if (segments.some((seg) => seg === '..')) {
        throw new Error('Недопустимый путь файла');
    }
    if (path.isAbsolute(n)) {
        throw new Error('Недопустимый путь файла');
    }
    return n;
}

function inboxDir(auditorSlug, projectId, kind) {
    const s = parseInboxScope(auditorSlug, projectId);
    const k = SOURCE_KINDS.includes(kind) ? kind : 'other';
    return path.join(s.root, k);
}

function workspaceDir(auditorSlug, projectId) {
    const s = parseInboxScope(auditorSlug, projectId);
    return path.join(s.root, WORKSPACE_SUBDIR);
}

function ensureWorkspaceDir(auditorSlug, projectId) {
    const dir = workspaceDir(auditorSlug, projectId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function ensureInboxDir(auditorSlug, projectId, kind) {
    const dir = inboxDir(auditorSlug, projectId, kind);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function walkFilesRecursive(dir, baseDir = dir) {
    const out = [];
    if (!fs.existsSync(dir)) return out;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...walkFilesRecursive(full, baseDir));
        } else if (ent.isFile()) {
            const rel = path.relative(baseDir, full).replace(/\\/g, '/');
            const stat = fs.statSync(full);
            out.push({
                absolutePath: full,
                name: ent.name,
                relativePath: rel,
                size: stat.size,
                mtime: stat.mtime.toISOString(),
            });
        }
    }
    return out;
}

function fileNameStartsWithPrefix(name, prefix) {
    const p = String(prefix || '');
    if (!p) return true;
    const norm = p.endsWith('_') ? p : `${p}_`;
    return String(name || '').toLowerCase().startsWith(norm.toLowerCase());
}

function filterInboxFiles(files, { kind, prefix } = {}) {
    let list = files;
    if (kind === 'broker') {
        list = list.filter((f) => BROKER_EXTS.has(path.extname(f.name).toLowerCase()));
        if (prefix) list = list.filter((f) => fileNameStartsWithPrefix(f.name, prefix));
    } else if (kind === 'depo') {
        list = list.filter((f) => PDF_EXTS.has(path.extname(f.name).toLowerCase()));
    } else if (kind === 'uk') {
        list = list.filter((f) => BROKER_EXTS.has(path.extname(f.name).toLowerCase()));
    }
    return list.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function probeInbox(auditorSlug, projectId, kind, { prefix } = {}) {
    const all = collectAllInboxEntries(auditorSlug, projectId).filter((e) => e.kind === kind);
    const filtered = filterInboxFiles(all, { kind, prefix });
    const prefixDefault = prefix || (kind === 'broker' ? '1F018_' : '');
    const prefixMatches =
        kind === 'broker' && prefixDefault
            ? all.filter(
                  (f) =>
                      BROKER_EXTS.has(path.extname(f.name).toLowerCase()) &&
                      fileNameStartsWithPrefix(f.name, prefixDefault)
              ).length
            : filtered.length;

    return {
        kind,
        inboxPath: workspaceDir(auditorSlug, projectId),
        fileCount: all.length,
        matchedCount: filtered.length,
        prefix: prefixDefault || null,
        prefixMatches,
        samplePaths: filtered.slice(0, 5).map((f) => f.relativePath),
        sampleNames: filtered.slice(0, 5).map((f) => f.name),
    };
}

function toOpifFileDescriptor(entry) {
    return {
        originalname: entry.name,
        name: entry.name,
        relativePath: entry.relativePath,
        absolutePath: entry.absolutePath,
    };
}

function listInboxForParse(auditorSlug, projectId, kind, { prefix } = {}) {
    const all = collectAllInboxEntries(auditorSlug, projectId).filter((e) => e.kind === kind);
    const filtered = filterInboxFiles(all, { kind, prefix });
    return filtered.map(toOpifFileDescriptor);
}

function detectInboxKindForFile(name) {
    const ext = path.extname(String(name || '')).toLowerCase();
    const base = path.basename(String(name || '')).toLowerCase();
    if (PDF_EXTS.has(ext)) return 'depo';
    if (BROKER_EXTS.has(ext)) {
        if (/^1f\d{3}_/.test(base)) return 'broker';
        return 'other';
    }
    if (['.txt', '.csv', '.tsv'].includes(ext)) return 'other';
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff'].includes(ext)) return 'other';
    return 'other';
}

function detectInboxKindFromMeta(meta) {
    const rel = String(meta?.relativePath || meta?.name || '')
        .replace(/\\/g, '/')
        .toLowerCase();
    const segments = rel.split('/').filter(Boolean);
    for (const seg of segments) {
        if (seg === 'broker' || seg.includes('брокер')) return 'broker';
        if (seg === 'depo' || seg === 'депо') return 'depo';
        if (seg === 'uk' || seg.includes('wealth') || seg.includes('уk')) return 'uk';
    }
    return detectInboxKindForFile(meta?.name);
}

function normalizeStoredRelativePath(relativePath) {
    const rel = assertSafeRelative(String(relativePath || '').replace(/\\/g, '/'));
    return rel || 'file';
}

function buildPathTree(files, { maxFilesPerFolder = 200 } = {}) {
    const root = { name: '', type: 'folder', path: '', children: [], fileCount: 0 };
    for (const f of files || []) {
        const rel = String(f.relativePath || f.name || '').replace(/\\/g, '/');
        const parts = rel.split('/').filter(Boolean);
        const fileName = parts.pop() || f.name;
        let node = root;
        const pathParts = [];
        for (const part of parts) {
            pathParts.push(part);
            let child = node.children.find((c) => c.type === 'folder' && c.name === part);
            if (!child) {
                child = {
                    name: part,
                    type: 'folder',
                    path: pathParts.join('/'),
                    children: [],
                    fileCount: 0,
                };
                node.children.push(child);
            }
            node = child;
        }
        const fileNode = {
            name: fileName,
            type: 'file',
            path: rel,
            size: f.size,
            mtime: f.mtime,
        };
        node.children.push(fileNode);
        node.fileCount += 1;
        root.fileCount += 1;
    }
    const sortNode = (n) => {
        if (n.type === 'folder') {
            n.children.sort((a, b) => {
                if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
                return a.name.localeCompare(b.name, 'ru');
            });
            n.children.forEach(sortNode);
            if (n.children.length > maxFilesPerFolder) {
                const filesOnly = n.children.filter((c) => c.type === 'file');
                const folders = n.children.filter((c) => c.type === 'folder');
                if (filesOnly.length > maxFilesPerFolder) {
                    n.children = [
                        ...folders,
                        ...filesOnly.slice(0, maxFilesPerFolder),
                        {
                            name: `… ещё ${filesOnly.length - maxFilesPerFolder} файлов`,
                            type: 'more',
                            path: n.path,
                            count: filesOnly.length - maxFilesPerFolder,
                        },
                    ];
                }
            }
        }
    };
    sortNode(root);
    return root;
}

function buildInboxTree(auditorSlug, projectId) {
    const s = parseInboxScope(auditorSlug, projectId);
    const entries = collectAllInboxEntries(auditorSlug, projectId);
    const byKind = SOURCE_KINDS.reduce((acc, kind) => {
        acc[kind] = entries.filter((e) => e.kind === kind).length;
        return acc;
    }, {});
    const kinds = SOURCE_KINDS.map((kind) => {
        const label =
            kind === 'broker'
                ? 'Брокер'
                : kind === 'uk'
                  ? 'УК'
                  : kind === 'depo'
                    ? 'ДЕПО'
                    : 'Прочее';
        const kindEntries = entries.filter((e) => e.kind === kind);
        return {
            kind,
            label,
            inboxPath: workspaceDir(auditorSlug, projectId),
            fileCount: kindEntries.length,
            tree: buildPathTree(kindEntries),
        };
    });
    return {
        scope: s,
        auditorSlug: s.mode === 'project' ? s.auditorSlug : 'martin',
        projectId: s.mode === 'project' ? s.projectId : null,
        chatSessionId: s.mode === 'chat' ? s.chatSessionId : null,
        inboxRoot: s.root,
        workspaceRoot: workspaceDir(auditorSlug, projectId),
        displayPath: s.label,
        totalFiles: entries.length,
        byKind,
        tree: buildPathTree(entries),
        kinds,
    };
}

function classifyFilesForInbox(filesMeta = []) {
    const grouped = { broker: [], uk: [], depo: [], other: [] };
    for (const meta of filesMeta) {
        const kind = detectInboxKindFromMeta(meta);
        grouped[kind].push(meta);
    }
    return grouped;
}

function saveInboxUploads(auditorSlug, projectId, kind, uploadedFiles, filesMeta = []) {
    const base = ensureInboxDir(auditorSlug, projectId, kind);
    let saved = 0;
    const paths = [];

    for (let i = 0; i < (uploadedFiles || []).length; i += 1) {
        const f = uploadedFiles[i];
        const meta = filesMeta[i] || {};
        const rel = normalizeStoredRelativePath(
            meta.relativePath || meta.name || f.originalname
        );
        const dest = path.join(base, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (f.buffer) {
            fs.writeFileSync(dest, f.buffer);
        } else if (f.path) {
            fs.copyFileSync(f.path, dest);
            try {
                fs.unlinkSync(f.path);
            } catch {
                /* temp cleanup */
            }
        } else {
            continue;
        }
        saved += 1;
        paths.push(rel);
    }

    return { saved, base, paths };
}

function saveInboxUploadsAuto(auditorSlug, projectId, uploadedFiles, filesMeta = []) {
    const base = ensureWorkspaceDir(auditorSlug, projectId);
    let saved = 0;
    const byKindSaved = {};
    const allPaths = [];

    for (let i = 0; i < (uploadedFiles || []).length; i += 1) {
        const f = uploadedFiles[i];
        const meta = filesMeta[i] || {};
        const rel = normalizeStoredRelativePath(
            meta.relativePath || meta.name || f.originalname
        );
        const kind = detectInboxKindFromMeta(meta);
        const dest = path.join(base, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        if (f.buffer) {
            fs.writeFileSync(dest, f.buffer);
        } else if (f.path) {
            fs.copyFileSync(f.path, dest);
            try {
                fs.unlinkSync(f.path);
            } catch {
                /* temp cleanup */
            }
        } else {
            continue;
        }
        saved += 1;
        byKindSaved[kind] = (byKindSaved[kind] || 0) + 1;
        allPaths.push(rel);
    }

    return { saved, base, byKindSaved, paths: allPaths };
}

function collectAllInboxEntries(auditorSlug, projectId) {
    const out = [];
    const seen = new Set();

    const pushEntry = (entry, kind) => {
        const key = `${entry.relativePath}|${entry.size}|${entry.mtime}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ ...entry, kind });
    };

    const ws = workspaceDir(auditorSlug, projectId);
    if (fs.existsSync(ws)) {
        for (const f of walkFilesRecursive(ws)) {
            pushEntry(f, detectInboxKindFromMeta({ relativePath: f.relativePath, name: f.name }));
        }
    }

    for (const kind of SOURCE_KINDS) {
        const base = inboxDir(auditorSlug, projectId, kind);
        if (!fs.existsSync(base)) continue;
        for (const f of walkFilesRecursive(base)) {
            pushEntry(f, kind);
        }
    }

    return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'ru'));
}

function probeInboxProject(auditorSlug, projectId, userMessage = '') {
    const entries = collectAllInboxEntries(auditorSlug, projectId);
    const fileMetas = entries.map((e) => ({
        name: e.name,
        relativePath: e.relativePath,
    }));
    const probe = probeFileList(fileMetas, userMessage);
    return {
        ...probe,
        totalFiles: entries.length,
        byKind: SOURCE_KINDS.reduce((acc, kind) => {
            acc[kind] = entries.filter((e) => e.kind === kind).length;
            return acc;
        }, {}),
        inboxRoot: parseInboxScope(auditorSlug, projectId).root,
    };
}

function filterEntriesByPathScope(entries, pathScope) {
    if (!pathScope?.path) return entries;
    const rel = normalizeStoredRelativePath(pathScope.path);
    if (pathScope.type === 'file') {
        return entries.filter((e) => e.relativePath === rel);
    }
    return entries.filter(
        (e) => e.relativePath === rel || e.relativePath.startsWith(`${rel}/`)
    );
}

function listInboxEntriesForParse(auditorSlug, projectId, { kind, prefix, userMessage, pathScope } = {}) {
    // Явный выбор файла/папки в UI — парсим ровно его, без эвристик opif_broker/depo.
    if (pathScope?.path && !kind) {
        return filterEntriesByPathScope(collectAllInboxEntries(auditorSlug, projectId), pathScope);
    }

    let entries;
    if (kind) {
        entries = listInboxForParse(auditorSlug, projectId, kind, { prefix }).map((d) => ({
            ...d,
            kind,
        }));
    } else {
        const probe = probeInboxProject(auditorSlug, projectId, userMessage);
        const scenarioId = probe.suggestedScenario;
        const filePrefix = probe.prefix || null;

        if (scenarioId === 'opif_broker') {
            entries = listInboxForParse(auditorSlug, projectId, 'broker', {
                prefix: filePrefix || '1F018_',
            }).map((d) => ({ ...d, kind: 'broker' }));
        } else if (scenarioId === 'opif_depo') {
            entries = listInboxForParse(auditorSlug, projectId, 'depo', {}).map((d) => ({
                ...d,
                kind: 'depo',
            }));
        } else {
            entries = collectAllInboxEntries(auditorSlug, projectId);
            if (entries.length === 1) {
                /* keep */
            } else if (entries.length > 1 && scenarioId) {
                const excel = entries.filter((e) =>
                    BROKER_EXTS.has(path.extname(e.name).toLowerCase())
                );
                if (excel.length === 1) entries = excel;
            }
        }
    }
    return filterEntriesByPathScope(entries, pathScope);
}

function summarizeProjectInbox(auditorSlug, projectId) {
    return SOURCE_KINDS.map((kind) => {
        const probe = probeInbox(auditorSlug, projectId, kind, {});
        const brokerProbe =
            kind === 'broker' ? probeInbox(auditorSlug, projectId, kind, { prefix: '1F018_' }) : null;
        return {
            kind,
            label:
                kind === 'broker'
                    ? 'Брокер'
                    : kind === 'uk'
                      ? 'УК'
                      : kind === 'depo'
                        ? 'ДЕПО'
                        : 'Прочее',
            fileCount: probe.fileCount,
            matchedCount: probe.matchedCount,
            prefix1F018: brokerProbe?.prefixMatches ?? null,
            inboxPath: probe.inboxPath,
        };
    });
}

function projectInboxRoot(auditorSlug, projectId) {
    return parseInboxScope(auditorSlug, projectId).root;
}

function clearProjectInbox(auditorSlug, projectId) {
    const root = projectInboxRoot(auditorSlug, projectId);
    const hadFiles = collectAllInboxEntries(auditorSlug, projectId).length;
    if (fs.existsSync(root)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
    return { cleared: true, deletedFiles: hadFiles, root };
}

function deleteInboxPath(auditorSlug, projectId, relativePath) {
    const rel = normalizeStoredRelativePath(relativePath);
    let deleted = 0;

    const tryRemove = (base) => {
        if (!base || !fs.existsSync(base)) return false;
        const target = path.join(base, rel);
        if (!fs.existsSync(target)) return false;
        if (fs.statSync(target).isDirectory()) {
            deleted = walkFilesRecursive(target, target).length;
            fs.rmSync(target, { recursive: true, force: true });
        } else {
            deleted = 1;
            fs.unlinkSync(target);
        }
        return true;
    };

    if (tryRemove(workspaceDir(auditorSlug, projectId))) {
        return { deleted, path: rel };
    }
    for (const kind of SOURCE_KINDS) {
        if (tryRemove(inboxDir(auditorSlug, projectId, kind))) {
            return { deleted, path: rel };
        }
    }
    throw new Error('Не нашла файл или папку в хранилище');
}

module.exports = {
    SOURCE_KINDS,
    WORKSPACE_SUBDIR,
    INBOX_ROOT,
    inboxDir,
    workspaceDir,
    ensureWorkspaceDir,
    ensureInboxDir,
    walkFilesRecursive,
    detectInboxKindForFile,
    detectInboxKindFromMeta,
    buildInboxTree,
    buildPathTree,
    classifyFilesForInbox,
    saveInboxUploadsAuto,
    collectAllInboxEntries,
    probeInboxProject,
    listInboxEntriesForParse,
    probeInbox,
    saveInboxUploads,
    listInboxForParse,
    summarizeProjectInbox,
    projectInboxRoot,
    clearProjectInbox,
    filterEntriesByPathScope,
    deleteInboxPath,
    toOpifFileDescriptor,
    fileNameStartsWithPrefix,
    parseInboxScope,
    normalizeStoredRelativePath,
};
