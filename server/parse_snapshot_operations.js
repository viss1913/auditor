const { parseResultTableCommand } = require('./result_table_commands');
const { buildReplaceMap, buildReplaceAssistantMessage } = require('./table_value_replace');
const {
    buildFilterAssistantMessage,
    isFilterContinuation,
    mergeFilterPlans,
    parseFilterIntent,
} = require('./table_row_filter');
const { mergeResultTableCommand } = require('./result_table_resolve');
const { planResultTableActionWithLlm } = require('./result_table_llm');
const {
    applyExtractFields,
    stripExtractedFromText,
    defaultExtractFields,
    classifyBatchUnique,
} = require('./cell_enrich');

const PROCESS_BATCH = 1000;

async function updateSnapshotHeaders(pool, snapshotId, headers) {
    await pool.query(`UPDATE parse_snapshots SET headers = $2::jsonb WHERE id = $1`, [
        snapshotId,
        JSON.stringify(headers),
    ]);
}

async function applySnapshotOperation(store, snapshotId, { message, options = {} }) {
    const snap = await store.getSnapshot(snapshotId);
    if (!snap) return { ok: false, error: 'Снимок не найден', status: 404 };
    if (snap.status !== 'ready') {
        return { ok: false, error: `Снимок в статусе «${snap.status}»`, status: 409 };
    }

    const headers = snap.headers || [];
    const chatHistory = Array.isArray(options.chatHistory) ? options.chatHistory : [];
    const lastFilterOp = await store.getLastTableOperation(snapshotId, 'filter_rows');

    let regexCmd = parseResultTableCommand(message, headers);
    const continuation =
        regexCmd.continuation ||
        isFilterContinuation(message) ||
        parseFilterIntent(message, headers).continuation;

    if (
        continuation &&
        lastFilterOp?.command?.filters?.length &&
        regexCmd.action === 'filter_rows'
    ) {
        const merged = mergeFilterPlans(lastFilterOp.command, regexCmd);
        regexCmd = {
            ...regexCmd,
            ...merged,
            planner: 'regex+history',
        };
    }

    const skipLlm =
        regexCmd.action === 'replace_values' ||
        regexCmd.action === 'clean_source' ||
        regexCmd.stripFromSource ||
        (regexCmd.action === 'filter_rows' && regexCmd.filters?.length) ||
        (regexCmd.action === 'extract' &&
            /(инвентар|номер).*(дат|дату)|(дат|дату).*(инвентар|номер)/i.test(message));

    let plan = null;
    if (options.useLlm !== false && message && !skipLlm) {
        try {
            const samplePage = await store.fetchRowsPage(snapshotId, { page: 1, limit: 5 });
            plan = await planResultTableActionWithLlm({
                message,
                headers,
                rows: (samplePage?.rows || []).map((r) => {
                    const copy = { ...r };
                    delete copy.__rowIndex;
                    return copy;
                }),
                chatHistory,
                activeFilter: lastFilterOp?.command || null,
            });
        } catch {
            plan = null;
        }
    }

    let command = mergeResultTableCommand({ message, headers, plan, regexCmd });
    if (
        command.action === 'filter_rows' &&
        continuation &&
        lastFilterOp?.command?.filters?.length
    ) {
        command = { ...command, ...mergeFilterPlans(lastFilterOp.command, command) };
    }
    const planner = command.planner || (plan ? 'llm' : 'regex');

    if (!command.action) {
        return { ok: true, handled: false, command, planner };
    }

    if (command.action === 'filter_rows') {
        if (!command.filters?.length) {
            return {
                ok: true,
                handled: true,
                command,
                planner,
                assistantMessage:
                    (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                    'Не смогла разобрать условия фильтра. Напиши, например: «оставь только debit_account=58.01.4 и credit_account=76.07.2».',
            };
        }

        const result = await store.filterRows(snapshotId, {
            mode: command.mode,
            combine: command.combine,
            filters: command.filters,
        });

        await store.logOperation(snapshotId, message, command, result.removed);

        return {
            ok: true,
            handled: true,
            command: { ...command, ...result.plan },
            planner,
            affectedRows: result.removed,
            rowCount: result.after,
            filterStats: result,
            assistantMessage:
                (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                buildFilterAssistantMessage(result.plan, result),
        };
    }

    if (command.action === 'replace_values') {
        const col = command.column;
        if (!col || !headers.includes(col)) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage:
                    'Не нашла колонку для замены. Укажи имя из заголовка, например: operationType.',
            };
        }
        const valueMap = buildReplaceMap(command.mappings);
        let affected = 0;

        await store.fetchAllRowsBatched(snapshotId, PROCESS_BATCH, async (batch) => {
            const updates = [];
            for (const { rowIndex, data } of batch) {
                const val = String(data[col] ?? '');
                const trimmed = val.trim();
                const next = valueMap.get(val) ?? valueMap.get(trimmed);
                if (next == null || next === val) continue;
                updates.push({ rowIndex, patch: { [col]: next } });
            }
            if (updates.length) {
                await store.updateRowsBatch(snapshotId, updates);
                affected += updates.length;
            }
        });

        await store.logOperation(snapshotId, message, command, affected);

        return {
            ok: true,
            handled: true,
            command,
            planner,
            affectedRows: affected,
            assistantMessage: buildReplaceAssistantMessage(col, command.mappings, affected),
        };
    }

    if (command.action === 'delete_column') {
        const col = command.deleteColumn || command.sourceColumn;
        if (!col) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: `Не нашла колонку «${command.rawColumnHint || '...'}».`,
            };
        }
        await store.pool.query(
            `UPDATE parsed_rows SET data = data - $2 WHERE snapshot_id = $1`,
            [snapshotId, col]
        );
        const newHeaders = headers.filter((h) => h !== col);
        await updateSnapshotHeaders(store.pool, snapshotId, newHeaders);
        await store.logOperation(snapshotId, message, command, snap.rowCount);
        return {
            ok: true,
            handled: true,
            command,
            deleteColumn: col,
            affectedRows: snap.rowCount,
            headers: newHeaders,
            assistantMessage: `Убрала колонку «${col}» из ${snap.rowCount} строк.`,
        };
    }

    if (!command.sourceColumn) {
        return {
            ok: true,
            handled: true,
            command,
            assistantMessage:
                'Не нашла колонку. Напиши: «колонка ОС» (точное имя из заголовка таблицы).',
        };
    }

    if (command.action === 'extract' || command.action === 'clean_source') {
        const fields =
            command.extractFields?.length > 0 ? command.extractFields : defaultExtractFields();
        const doStrip = command.action === 'clean_source' || command.stripFromSource;
        const onlyClean = command.action === 'clean_source';
        let affected = 0;
        const previewSample = [];
        const newColSet = new Set(onlyClean ? [] : fields.map((f) => f.target_column));

        await store.fetchAllRowsBatched(snapshotId, PROCESS_BATCH, async (batch) => {
            const updates = [];
            for (const { rowIndex, data } of batch) {
                const text = String(data[command.sourceColumn] ?? '');
                const extracted = applyExtractFields(text, fields);
                const patch = onlyClean ? {} : { ...extracted };
                if (doStrip && command.sourceColumn) {
                    patch[command.sourceColumn] = stripExtractedFromText(text);
                }
                if (Object.keys(patch).length) {
                    updates.push({ rowIndex, patch });
                    if (previewSample.length < 5) {
                        previewSample.push({ index: rowIndex, values: patch });
                    }
                }
            }
            if (updates.length) {
                await store.updateRowsBatch(snapshotId, updates);
                affected += updates.length;
            }
        });

        const mergedHeaders = [...headers];
        for (const c of newColSet) {
            if (c && !mergedHeaders.includes(c)) mergedHeaders.push(c);
        }
        if (mergedHeaders.length !== headers.length) {
            await updateSnapshotHeaders(store.pool, snapshotId, mergedHeaders);
        }

        const newCols = [...newColSet].filter(Boolean);
        const stripNote = doStrip ? ` Очистила текст в «${command.sourceColumn}».` : '';
        const colsNote = newCols.length
            ? `Добавила колонки: ${newCols.join(', ')}. Прокрути таблицу вправо.`
            : '';

        await store.logOperation(snapshotId, message, command, affected);

        return {
            ok: true,
            handled: true,
            command: { ...command, extractFields: fields },
            planner,
            affectedRows: affected,
            newColumns: newCols,
            headers: mergedHeaders,
            previewSample,
            assistantMessage:
                (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                `Готово (${affected} строк): ${colsNote}${stripNote}`.trim(),
        };
    }

    if (command.action === 'classify') {
        const threshold = Number.isFinite(options.threshold) ? Number(options.threshold) : command.threshold || 0.7;
        const auditorRule = String(options.auditorRule || command.auditorRule || '').trim();
        const maxUnique = Number.isFinite(options.maxUnique) ? Number(options.maxUnique) : 80;

        const distinct = await store.getDistinctColumnValues(snapshotId, command.sourceColumn, 5000);
        const batch = await classifyBatchUnique(distinct, { threshold, auditorRule, maxUnique });
        const classes = batch.results || [];
        const valueToClass = new Map();
        distinct.forEach((val, i) => {
            if (val != null) valueToClass.set(val, classes[i]);
        });

        let affected = 0;
        const previewSample = [];

        await store.fetchAllRowsBatched(snapshotId, PROCESS_BATCH, async (batch) => {
            const updates = [];
            for (const { rowIndex, data } of batch) {
                const val = String(data[command.sourceColumn] ?? '');
                const cls = valueToClass.get(val);
                if (!cls) continue;
                const patch = {
                    asset_class: cls.class,
                    asset_confidence: cls.confidence,
                    asset_reason: cls.reason,
                };
                updates.push({ rowIndex, patch });
                if (previewSample.length < 5) {
                    previewSample.push({ index: rowIndex, values: patch });
                }
            }
            if (updates.length) {
                await store.updateRowsBatch(snapshotId, updates);
                affected += updates.length;
            }
        });

        const mergedHeaders = [...headers];
        for (const c of ['asset_class', 'asset_confidence', 'asset_reason']) {
            if (!mergedHeaders.includes(c)) mergedHeaders.push(c);
        }
        await updateSnapshotHeaders(store.pool, snapshotId, mergedHeaders);

        const truncNote = batch.truncated
            ? ` (лимит: классифицировано ${batch.uniqueClassified} уникальных значений)`
            : '';

        await store.logOperation(snapshotId, message, command, affected);

        return {
            ok: true,
            handled: true,
            command,
            planner,
            affectedRows: affected,
            newColumns: ['asset_class', 'asset_confidence', 'asset_reason'],
            headers: mergedHeaders,
            previewSample,
            meta: {
                uniqueClassified: batch.uniqueClassified,
                truncated: batch.truncated,
                auditorRule,
            },
            assistantMessage:
                (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                `Готово: «${command.sourceColumn}» → asset_class, asset_confidence, asset_reason (${affected} строк).${truncNote}`,
        };
    }

    return { ok: true, handled: false, command, planner };
}

module.exports = { applySnapshotOperation, updateSnapshotHeaders };
