const { detectSourceKind } = require('./file_dispatch');
const { parseUniversal } = require('./universal_parse/universal_parse_orchestrator');
const { parseRequestedTableColumns } = require('./document_scan_llm');
const { scenarioDisplayName } = require('./scenarios/catalog');
const { runExcelStructureAutostart } = require('./structure_autostart');
const { fileNameOf } = require('./opif_martin');
const {
    groupFilesByStructure,
    buildMergeStrategyQuestion,
    headersCompatible,
    serializeGroupsForClient,
} = require('./universal_parse/file_group_resolver');
const { detectMergeStrategyFromMessage } = require('./orchestrator/parse_plan');
const { PREVIEW_ROWS_CLIENT } = require('./parse_snapshot_import');

function isPdfLikeFile(file) {
    const kind = detectSourceKind(fileNameOf(file));
    return kind === 'pdf' || kind === 'image_scan';
}

/**
 * @returns {Promise<{ proceed: boolean, mergeStrategy?: string, groups?: Array, question?: object }>}
 */
async function resolveBatchMergeContext({
    files,
    orchestratorAnswers = {},
    userMessage = '',
    scenarioId = null,
    appendSnapshotId = null,
    isOpif = false,
}) {
    if (!files?.length || files.length <= 1 || isOpif || appendSnapshotId) {
        return { proceed: true, mergeStrategy: 'one_table', groups: [] };
    }

    const groups = await groupFilesByStructure(files);
    const serialized = serializeGroupsForClient(groups);
    const mergeStrategy =
        detectMergeStrategyFromMessage(userMessage, serialized, orchestratorAnswers) ||
        (serialized.length <= 1 ? 'one_table' : null);

    if (!mergeStrategy && serialized.length > 1) {
        return {
            proceed: false,
            groups: serialized,
            question: buildMergeStrategyQuestion(serialized),
        };
    }

    return {
        proceed: true,
        mergeStrategy: mergeStrategy || 'one_table',
        groups: serialized,
        rawGroups: groups,
    };
}

async function parseSingleUniversalFile({ pool, file, projectId, userMessage }) {
    return parseUniversal({
        pool,
        file,
        projectId,
        userMessage,
    });
}

function alignRowToHeaders(row, headers) {
    const out = {};
    for (const h of headers) {
        out[h] = row[h] != null ? row[h] : '';
    }
    return out;
}

function mergeHeaders(existing, incoming) {
    const set = new Set(existing || []);
    for (const h of incoming || []) {
        if (h && !set.has(h)) set.add(h);
    }
    if (!set.has('source_file')) set.add('source_file');
    return [...set];
}

async function parseExcelFilesToRows({
    pool,
    files,
    targetFile,
    projectId,
    savedRules,
    userMessage,
}) {
    const parsed = [];
    const skipped = [];
    for (const file of files) {
        const result = await runExcelStructureAutostart({
            pool,
            file,
            targetFile,
            sheetName: null,
            projectId,
            savedRules,
        });
        if (result?.ok && result.parsePreview?.rows?.length) {
            const rows = result.parsePreview.rows.map((row) => ({
                ...row,
                source_file: row.source_file || fileNameOf(file),
            }));
            parsed.push({
                file,
                headers: result.parsePreview.headers || [],
                rows,
                scenarioId: result.scenarioId,
                result,
            });
        } else {
            skipped.push({
                fileName: fileNameOf(file),
                reason: result?.assistantMessage || result?.reason || 'unknown_structure',
            });
        }
    }
    return { parsed, skipped };
}

async function parsePdfFilesToRows({ pool, files, projectId, userMessage }) {
    const requestedHeaders = parseRequestedTableColumns(userMessage);
    const parsed = [];
    const skipped = [];
    let headers = requestedHeaders.length ? [...requestedHeaders] : [];

    for (const file of files) {
        const name = fileNameOf(file);
        try {
            const result = await parseSingleUniversalFile({ pool, file, projectId, userMessage });
            const previewRows = result.parsePreview?.rows || [];
            if (!previewRows.length) {
                skipped.push({
                    fileName: name,
                    reason: result.assistantMessage || (result.errors || ['нет строк']).join('; '),
                });
                continue;
            }
            if (!headers.length && result.parsePreview?.headers?.length) {
                headers = [...result.parsePreview.headers];
            }
            const rows = previewRows.map((row) => ({
                ...row,
                source_file: row.source_file || name,
            }));
            parsed.push({
                file,
                headers: result.parsePreview.headers || headers,
                rows,
                scenarioId: result.scenarioId,
                result,
            });
        } catch (err) {
            skipped.push({ fileName: name, reason: err.message });
        }
    }
    return { parsed, skipped, headers };
}

function flattenParsedChunks(parsedChunks, baseHeaders = []) {
    let headers = [...baseHeaders];
    const allRows = [];
    for (const chunk of parsedChunks) {
        headers = mergeHeaders(headers, chunk.headers);
        for (const row of chunk.rows) {
            allRows.push({ ...row });
        }
    }
    const normalized = allRows.map((row) => alignRowToHeaders(row, headers));
    return { headers, rows: normalized };
}

async function importMergedSnapshot(snapshotStore, {
    projectId,
    sourceFileName,
    scenarioId,
    headers,
    rows,
}) {
    const snapshotId = await snapshotStore.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName,
        sheetName: null,
        scenarioId,
        headers,
        status: 'parsing',
    });
    const rowCount = await snapshotStore.importParsedRows(snapshotId, headers, rows);
    return { snapshotId, rowCount };
}

/**
 * @param {'one_table'|'by_group'|'per_file'} mergeStrategy
 */
async function runBatchWithMergeStrategy({
    pool,
    snapshotStore,
    files,
    rawGroups,
    mergeStrategy,
    targetFile,
    projectId,
    savedRules,
    userMessage,
    chatSessionId,
    parsePlan,
    maybeLinkSnapshotToChat,
    logChatExchange,
}) {
    const normalizedGroups =
        rawGroups?.length > 0
            ? rawGroups
            : await groupFilesByStructure(files);

    const excelFiles = files.filter((f) => detectSourceKind(fileNameOf(f)) === 'excel');
    const pdfFiles = files.filter((f) => isPdfLikeFile(f));
    const isExcelBatch = excelFiles.length === files.length;
    const isPdfBatch = pdfFiles.length === files.length;

    const snapshots = [];
    const skipped = [];

    const parseFileSet = async (fileSet, label) => {
        if (!fileSet.length) return null;
        if (isExcelBatch) {
            const { parsed, skipped: sk } = await parseExcelFilesToRows({
                pool,
                files: fileSet,
                targetFile,
                projectId,
                savedRules,
                userMessage,
            });
            skipped.push(...sk);
            if (!parsed.length) return null;
            const { headers, rows } = flattenParsedChunks(parsed);
            const scenarioId = parsed[0].scenarioId || 'unknown_table';
            const { snapshotId, rowCount } = await importMergedSnapshot(snapshotStore, {
                projectId,
                sourceFileName: label,
                scenarioId,
                headers,
                rows,
            });
            return {
                snapshotId,
                sheetName: label,
                label: `${label} · ${rowCount}`,
                rowCount,
                scenarioId,
                scenarioName: scenarioDisplayName(scenarioId),
                parsePreview: {
                    headers,
                    rows: rows.slice(0, PREVIEW_ROWS_CLIENT),
                    rowCount,
                },
            };
        }
        if (isPdfBatch) {
            const { parsed, skipped: sk, headers } = await parsePdfFilesToRows({
                pool,
                files: fileSet,
                projectId,
                userMessage,
            });
            skipped.push(...sk);
            if (!parsed.length) return null;
            const merged = flattenParsedChunks(parsed, headers);
            const scenarioId = parsed[0].scenarioId || 'pdf_extracted';
            const { snapshotId, rowCount } = await importMergedSnapshot(snapshotStore, {
                projectId,
                sourceFileName: label,
                scenarioId,
                headers: merged.headers,
                rows: merged.rows,
            });
            return {
                snapshotId,
                sheetName: label,
                label: `${label} · ${rowCount}`,
                rowCount,
                scenarioId,
                scenarioName: scenarioDisplayName(scenarioId),
                parsePreview: {
                    headers: merged.headers,
                    rows: merged.rows.slice(0, PREVIEW_ROWS_CLIENT),
                    rowCount,
                },
            };
        }
        return null;
    };

    if (mergeStrategy === 'one_table') {
        const label = `batch_${files.length}files`;
        const snap = await parseFileSet(files, label);
        if (!snap) {
            return { ok: false, error: 'Не удалось разобрать файлы в одну таблицу', skipped };
        }
        snapshots.push(snap);
    } else if (mergeStrategy === 'by_group') {
        for (let i = 0; i < normalizedGroups.length; i++) {
            const g = normalizedGroups[i];
            const groupFiles = g.files?.length ? g.files : files;
            const label = `${g.label || `group_${i + 1}`}_${groupFiles.length}files`;
            const snap = await parseFileSet(groupFiles, label);
            if (snap) snapshots.push(snap);
        }
    } else {
        for (const file of files) {
            const name = fileNameOf(file);
            const snap = await parseFileSet([file], name);
            if (snap) snapshots.push(snap);
        }
    }

    if (!snapshots.length) {
        return { ok: false, error: 'Не разобрала ни один файл', skipped };
    }

    if (chatSessionId) {
        for (const s of snapshots) {
            await maybeLinkSnapshotToChat({
                chatSessionId,
                snapshotId: s.snapshotId,
                projectId,
                label: s.label,
            });
        }
    }

    const primary = snapshots[0];
    const assistantMessage = [
        mergeStrategy === 'one_table'
            ? `Собрала **${primary.rowCount}** строк из **${files.length}** файл(ов) в одну таблицу.`
            : mergeStrategy === 'by_group'
              ? `Собрала **${snapshots.length}** таблиц по структуре из **${files.length}** файл(ов).`
              : `Разобрала **${snapshots.length}** таблиц (по файлам).`,
        skipped.length
            ? `Пропустила: ${skipped.map((s) => `${s.fileName} (${s.reason})`).join('; ')}.`
            : '',
        parsePlan?.summary ? `\n📋 План: ${parsePlan.summary}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    if (chatSessionId) {
        await logChatExchange({
            chatSessionId,
            projectId,
            snapshotId: primary.snapshotId,
            userMessage,
            assistantMessage,
        });
    }

    return {
        ok: true,
        multiSheet: snapshots.length > 1,
        snapshots,
        snapshotId: primary.snapshotId,
        parsePreview: primary.parsePreview,
        scenarioId: primary.scenarioId,
        scenarioName: primary.scenarioName,
        assistantMessage,
        skipped,
        mergeStrategy,
    };
}

async function handleUniversalAppend({
    pool,
    snapshotStore,
    files,
    appendSnapshotId,
    projectId,
    userMessage,
    chatSessionId,
    targetFile,
    savedRules,
    maybeLinkSnapshotToChat,
    logChatExchange,
}) {
    const targetSnap = await snapshotStore.getSnapshot(appendSnapshotId);
    if (!targetSnap) {
        return { ok: false, status: 404, error: 'Таблица для дозаписи не найдена' };
    }

    const file = files[0];
    const kind = detectSourceKind(fileNameOf(file));
    let parsedRows = [];
    let parsedHeaders = targetSnap.headers || [];
    let scenarioId = targetSnap.scenarioId;

    if (kind === 'excel' && file.buffer) {
        const result = await runExcelStructureAutostart({
            pool,
            file,
            targetFile,
            sheetName: null,
            projectId,
            savedRules,
        });
        if (!result?.ok || !result.parsePreview?.rows?.length) {
            return {
                ok: false,
                status: 422,
                error: result?.assistantMessage || 'Не удалось разобрать Excel для дозаписи',
            };
        }
        parsedHeaders = result.parsePreview.headers || parsedHeaders;
        parsedRows = result.parsePreview.rows.map((row) => ({
            ...row,
            source_file: row.source_file || fileNameOf(file),
        }));
        scenarioId = result.scenarioId || scenarioId;
    } else if (isPdfLikeFile(file)) {
        const result = await parseSingleUniversalFile({ pool, file, projectId, userMessage });
        parsedHeaders = result.parsePreview?.headers || parsedHeaders;
        parsedRows = (result.parsePreview?.rows || []).map((row) => ({
            ...row,
            source_file: row.source_file || fileNameOf(file),
        }));
        scenarioId = result.scenarioId || scenarioId;
    } else if (targetSnap.scenarioId && (targetSnap.scenarioId === 'opif_depo' || targetSnap.scenarioId === 'opif_broker')) {
        return { ok: false, status: 422, error: 'Для OPIF используй стандартный append через брокер/депо' };
    } else {
        return { ok: false, status: 422, error: `Тип файла не поддержан для append: ${kind}` };
    }

    const compat = headersCompatible(targetSnap.headers, parsedHeaders);
    if (!compat.ok) {
        return {
            ok: false,
            status: 422,
            error: compat.warning || 'Заголовки не совпадают с открытой таблицей',
            headerMismatch: true,
        };
    }

    const aligned = parsedRows.map((row) => alignRowToHeaders(row, targetSnap.headers));
    const appended = await snapshotStore.appendParsedRows(appendSnapshotId, aligned);

    const assistantMessage = [
        `Добавила **${appended.added}** строк из **${fileNameOf(file)}** в таблицу.`,
        `Всего строк: **${appended.rowCount}**.`,
        compat.warning ? `⚠ ${compat.warning}` : '',
    ]
        .filter(Boolean)
        .join('\n');

    if (chatSessionId) {
        await logChatExchange({
            chatSessionId,
            projectId,
            snapshotId: appendSnapshotId,
            userMessage: userMessage || '(дозапись в таблицу)',
            assistantMessage,
        });
    }

    const page = await snapshotStore.fetchRowsPage(appendSnapshotId, {
        page: 1,
        limit: PREVIEW_ROWS_CLIENT,
    });

    return {
        ok: true,
        snapshotId: appendSnapshotId,
        appendMode: true,
        parsePreview: {
            headers: page.headers || targetSnap.headers,
            rows: page.rows?.map((r) => r.data) || [],
            rowCount: appended.rowCount,
        },
        scenarioId,
        scenarioName: scenarioDisplayName(scenarioId),
        assistantMessage,
        warnings: compat.warning ? [compat.warning] : [],
    };
}

module.exports = {
    resolveBatchMergeContext,
    runBatchWithMergeStrategy,
    handleUniversalAppend,
    isPdfLikeFile,
};
