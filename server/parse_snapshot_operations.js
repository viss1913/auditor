const {
    parseResultTableCommand,
    formatColumnNotFoundMessage,
    actionNeedsSourceColumn,
    extractFillValueFromTemplate,
    removeTransferredFromSource,
} = require('./result_table_commands');
const { buildReplaceMap, buildReplaceAssistantMessage } = require('./table_value_replace');
const { buildFilterAssistantMessage, buildSplitAssistantMessage } = require('./table_row_filter');
const { resolveTableCommand } = require('./result_table_resolve_command');
const {
    applyExtractFields,
    stripExtractedFromText,
    inferExtractFieldsFromMessage,
    stripTargetsFromFields,
    classifyBatchUnique,
} = require('./cell_enrich');
const { deriveFromContainsRules, stripPhrasesFromText, parseContainsRulesFromMessage } = require('./operation_type_derive');
const {
    expandKsCompositeRow,
    hasCompositeAnalyticsColumns,
    KS_CARD_HEADERS,
} = require('./ks_sheet_martin');

const PROCESS_BATCH = 1000;

async function applyFillFromSourceBatch(store, snapshotId, command) {
    const targetColumn = command.targetColumn || command.newColumnName;
    const fillFromColumn = command.fillFromColumn;
    const fillTemplate = command.fillTemplate || '';
    const stripSource = Boolean(command.stripFillFromSource);
    const fillTarget = command.action !== 'strip_fill_source';
    let filled = 0;
    let stripped = 0;

    await store.fetchAllRowsBatched(snapshotId, PROCESS_BATCH, async (batch) => {
        const updates = [];
        for (const { rowIndex, data } of batch) {
            const srcVal = data[fillFromColumn];
            let extracted = '';
            let stripPhrases = [];

            if (command.containsRules?.length) {
                const derived = deriveFromContainsRules(srcVal, command.containsRules);
                extracted = derived.value;
                stripPhrases = derived.stripPhrases;
            } else {
                extracted = extractFillValueFromTemplate(srcVal, fillTemplate, targetColumn);
            }

            const patch = {};

            if (fillTarget && targetColumn) {
                if (extracted) filled += 1;
                patch[targetColumn] = extracted;
            }

            if (stripSource) {
                let cleaned;
                if (stripPhrases.length) {
                    cleaned = stripPhrasesFromText(srcVal, stripPhrases);
                } else {
                    cleaned = removeTransferredFromSource(
                        srcVal,
                        extracted,
                        fillTemplate,
                        targetColumn
                    );
                }
                const before = String(srcVal ?? '').trim();
                const after = String(cleaned ?? '').trim();
                if (after !== before) stripped += 1;
                patch[fillFromColumn] = cleaned;
            }

            if (Object.keys(patch).length) {
                updates.push({ rowIndex, patch });
            }
        }
        if (updates.length) await store.updateRowsBatch(snapshotId, updates);
    });

    return { filled, stripped };
}

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

    const samplePage = await store.fetchRowsPage(snapshotId, { page: 1, limit: 5 });
    const sampleRows = (samplePage?.rows || []).map((r) => {
        const copy = { ...r };
        delete copy.__rowIndex;
        return copy;
    });

    const { command, planner } = await resolveTableCommand({
        message,
        headers,
        rows: sampleRows,
        options: {
            ...options,
            chatHistory,
            lastFilterOp,
            useLlm: options.useLlm,
        },
    });

    if (!command.action) {
        return { ok: true, handled: false, command, planner };
    }

    if (command.action === 'undo_last') {
        const lastOp = await store.getLastOperation(snapshotId);
        if (!lastOp?.rollbackPayload) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: 'Нечего отменять — последняя операция без отката или её нет.',
            };
        }

        const rb = lastOp.rollbackPayload;
        if (rb.type === 'filter_rows' && rb.deletedRows?.length) {
            const restored = await store.restoreRowsAtIndices(snapshotId, rb.deletedRows);
            await store.logOperation(snapshotId, message, { action: 'undo_last', undone: lastOp.command }, restored);
            return {
                ok: true,
                handled: true,
                command: { action: 'undo_last', undoneAction: lastOp.command?.action },
                affectedRows: restored,
                rowCount: (snap.rowCount || 0) + restored,
                assistantMessage: `Отменила фильтр: вернула ${restored} строк.`,
            };
        }

        if (rb.type === 'delete_column' && rb.column) {
            const headersBefore = rb.headersBefore || headers;
            await updateSnapshotHeaders(store.pool, snapshotId, headersBefore);
            const updates = (rb.columnValues || []).map(({ rowIndex, value }) => ({
                rowIndex,
                patch: { [rb.column]: value },
            }));
            if (updates.length) await store.updateRowsBatch(snapshotId, updates);
            await store.logOperation(
                snapshotId,
                message,
                { action: 'undo_last', undone: lastOp.command },
                updates.length
            );
            return {
                ok: true,
                handled: true,
                command: { action: 'undo_last', undoneAction: lastOp.command?.action },
                affectedRows: updates.length,
                headers: headersBefore,
                assistantMessage: `Отменила удаление колонки «${rb.column}».`,
            };
        }

        return {
            ok: true,
            handled: true,
            command,
            assistantMessage: `Откат для «${lastOp.command?.action || 'операции'}» пока не поддерживается.`,
        };
    }

    if (command.action === 'split_to_table') {
        if (!command.filters?.length) {
            return {
                ok: true,
                handled: true,
                command,
                planner,
                assistantMessage:
                    (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                    'Не смогла разобрать, какие строки переносить. Напиши, например: «сделай новую таблицу ВТБ — все строки, где name содержит ВТБ».',
            };
        }

        const result = await store.copyRowsToNewSnapshot(snapshotId, {
            plan: {
                mode: command.mode,
                combine: command.combine,
                filters: command.filters,
            },
            label: command.tableLabel || 'выборка',
        });

        await store.logOperation(snapshotId, message, command, result.rowCount);

        return {
            ok: true,
            handled: true,
            command,
            planner,
            newSnapshotId: result.newSnapshotId,
            tableLabel: result.tableLabel,
            rowCount: result.rowCount,
            sourceRowCount: result.sourceRowCount,
            affectedRows: result.rowCount,
            assistantMessage:
                (command.explanation ? `**Поняла:** ${command.explanation}\n\n` : '') +
                buildSplitAssistantMessage(result.plan, {
                    tableLabel: result.tableLabel,
                    rowCount: result.rowCount,
                    sourceRowCount: result.sourceRowCount,
                }),
        };
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

        const { deletedRows } = await store.collectRowsToDelete(snapshotId, {
            mode: command.mode,
            combine: command.combine,
            filters: command.filters,
        });

        const result = await store.filterRows(snapshotId, {
            mode: command.mode,
            combine: command.combine,
            filters: command.filters,
        });

        await store.logOperation(snapshotId, message, command, result.removed, {
            type: 'filter_rows',
            deletedRows,
            headers: [...headers],
        });

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

    if (command.action === 'expand_ks_analytics') {
        if (!hasCompositeAnalyticsColumns(headers)) {
            return {
                ok: true,
                handled: true,
                command,
                planner,
                assistantMessage:
                    'В таблице нет колонок «Аналитика Дт» / «Аналитика Кт» — раскрывать нечего. Сначала загрузи исходную выгрузку 1С.',
            };
        }

        let affected = 0;
        await store.fetchAllRowsBatched(snapshotId, PROCESS_BATCH, async (batch) => {
            const updates = batch.map(({ rowIndex, data }) => ({
                rowIndex,
                data: expandKsCompositeRow(data),
            }));
            if (updates.length) {
                await store.replaceRowsBatch(snapshotId, updates);
                affected += updates.length;
            }
        });

        await updateSnapshotHeaders(store.pool, snapshotId, [...KS_CARD_HEADERS]);
        await store.logOperation(snapshotId, message, command, affected);

        return {
            ok: true,
            handled: true,
            command,
            planner,
            affectedRows: affected,
            headers: [...KS_CARD_HEADERS],
            assistantMessage:
                `Раскрыла аналитику в плоские колонки (${affected} строк): контрагент, номенклатура, ставка, товар и т.д. Прокрути таблицу вправо.`,
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
        const columnValues = await store.collectColumnValues(snapshotId, col);
        const headersBefore = [...headers];
        await store.pool.query(
            `UPDATE parsed_rows SET data = data - $2 WHERE snapshot_id = $1`,
            [snapshotId, col]
        );
        const newHeaders = headers.filter((h) => h !== col);
        await updateSnapshotHeaders(store.pool, snapshotId, newHeaders);
        await store.logOperation(snapshotId, message, command, snap.rowCount, {
            type: 'delete_column',
            column: col,
            headersBefore,
            columnValues,
        });
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

    if (command.action === 'move_column') {
        const fromCol = command.sourceColumn;
        const anchorCol = command.afterColumn;
        if (!fromCol || !anchorCol) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: formatColumnNotFoundMessage(
                    headers,
                    command.rawColumnHint || command.rawAfterHint
                ),
            };
        }
        const moved = await store.reorderColumns(
            snapshotId,
            fromCol,
            anchorCol,
            command.position || 'after'
        );
        if (!moved.ok) {
            return { ok: true, handled: true, command, assistantMessage: moved.error };
        }
        await store.logOperation(snapshotId, message, command, snap.rowCount);
        const posWord = command.position === 'before' ? 'перед' : 'после';
        return {
            ok: true,
            handled: true,
            command,
            headers: moved.headers,
            assistantMessage: `Перенесла колонку «${fromCol}» ${posWord} «${anchorCol}».`,
        };
    }

    if (command.action === 'rename_column') {
        const oldName = command.sourceColumn;
        const newName = command.newColumnName;
        if (!oldName) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: formatColumnNotFoundMessage(headers, command.rawColumnHint),
            };
        }
        if (!newName) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: 'Укажи новое имя колонки, например: «переименуй колонку Группа в Категория».',
            };
        }
        const renamed = await store.renameColumn(snapshotId, oldName, newName);
        if (!renamed.ok) {
            return { ok: true, handled: true, command, assistantMessage: renamed.error };
        }
        await store.logOperation(snapshotId, message, command, renamed.affected);
        return {
            ok: true,
            handled: true,
            command,
            headers: renamed.headers,
            affectedRows: renamed.affected,
            assistantMessage: `Переименовала «${oldName}» → «${newName}» (${renamed.affected} строк).`,
        };
    }

    if (command.action === 'add_column') {
        const newName = command.newColumnName;
        if (!newName) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: 'Укажи имя новой колонки, например: «добавь колонку Комментарий».',
            };
        }
        if (command.rawFillColumnHint && !command.fillFromColumn) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: formatColumnNotFoundMessage(headers, command.rawFillColumnHint),
            };
        }
        const added = await store.addColumn(snapshotId, newName, '', {
            afterColumn: command.afterColumn,
            position: command.position || 'after',
        });
        if (!added.ok) {
            const snapNow = await store.getSnapshot(snapshotId);
            const headersNow = snapNow?.headers || headers;
            const alreadyThere = /уже есть/i.test(String(added.error || ''));
            const containsRules =
                command.containsRules?.length > 0
                    ? command.containsRules
                    : parseContainsRulesFromMessage(message);
            if (alreadyThere && headersNow.includes(newName) && (containsRules.length || command.fillFromColumn)) {
                const sourceCol =
                    command.fillFromColumn && command.fillFromColumn !== newName
                        ? command.fillFromColumn
                        : headersNow.includes('operation_type')
                          ? 'operation_type'
                          : command.fillFromColumn;
                if (sourceCol && sourceCol !== newName) {
                    const fillCmd = {
                        ...command,
                        action: 'fill_column',
                        targetColumn: newName,
                        fillFromColumn: sourceCol,
                        containsRules: containsRules.length ? containsRules : command.containsRules,
                    };
                    const batchResult = await applyFillFromSourceBatch(store, snapshotId, fillCmd);
                    await store.logOperation(snapshotId, message, fillCmd, snapNow.rowCount);
                    const stripNote =
                        command.stripFillFromSource && batchResult.stripped > 0
                            ? `. Убрала перенесённое из **${batchResult.stripped}** ячеек «${sourceCol}»`
                            : '';
                    return {
                        ok: true,
                        handled: true,
                        command: fillCmd,
                        headers: headersNow,
                        newColumns: [newName],
                        affectedRows: snapNow.rowCount,
                        assistantMessage: `Колонка «${newName}» уже была — заполнила **${batchResult.filled}** из **${snapNow.rowCount}** строк${stripNote}.`,
                    };
                }
            }
            return {
                ok: true,
                handled: true,
                command,
                headers: headersNow,
                newColumns: alreadyThere && headersNow.includes(newName) ? [newName] : undefined,
                assistantMessage: alreadyThere
                    ? `${added.error} Обнови отображение — колонка уже в snapshot.`
                    : added.error,
            };
        }

        let filled = 0;
        let stripped = 0;
        if (command.fillFromColumn) {
            const batchResult = await applyFillFromSourceBatch(store, snapshotId, command);
            filled = batchResult.filled;
            stripped = batchResult.stripped;
        }

        await store.logOperation(snapshotId, message, command, added.affected);
        const fillNote = command.fillFromColumn
            ? `, заполнила **${filled}** из **${added.affected}** строк`
            : ` (${added.affected} строк)`;
        const stripNote =
            command.stripFillFromSource && stripped > 0
                ? `. Убрала перенесённое из **${stripped}** ячеек «${command.fillFromColumn}»`
                : '';
        const posNote =
            command.afterColumn && added.headers.includes(newName)
                ? command.position === 'before'
                    ? ` перед «${command.afterColumn}»`
                    : ` после «${command.afterColumn}»`
                : command.rawAfterHint && !command.afterColumn
                  ? ` (не нашла якорь «${command.rawAfterHint}» — колонка в конце)`
                  : '';
        return {
            ok: true,
            handled: true,
            command,
            headers: added.headers,
            newColumns: [newName],
            affectedRows: added.affected,
            assistantMessage: `Добавила колонку «${newName}»${posNote}${fillNote}${stripNote}.`,
        };
    }

    if (command.action === 'fill_column' || command.action === 'strip_fill_source') {
        const targetColumn = command.targetColumn || command.newColumnName;
        const fillFromColumn = command.fillFromColumn;

        if (!fillFromColumn) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: formatColumnNotFoundMessage(headers, command.rawFillColumnHint),
            };
        }
        if (command.action === 'fill_column' && !targetColumn) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage:
                    'Не поняла, в какую колонку переносить. Напиши имя, например: «заполни колонку Подразделение из Аналитика Кт».',
            };
        }
        if (command.action === 'fill_column' && targetColumn && !headers.includes(targetColumn)) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: `Колонки «${targetColumn}» нет. Сначала создай её или укажи существующую.`,
            };
        }

        const { filled, stripped } = await applyFillFromSourceBatch(store, snapshotId, command);
        await store.logOperation(snapshotId, message, command, Math.max(filled, stripped));

        if (command.action === 'strip_fill_source') {
            return {
                ok: true,
                handled: true,
                command,
                affectedRows: stripped,
                assistantMessage:
                    stripped > 0
                        ? `Убрала перенесённое из **${stripped}** ячеек «${fillFromColumn}».`
                        : `В «${fillFromColumn}» не нашла значений для удаления.`,
            };
        }

        const stripNote =
            command.stripFillFromSource && stripped > 0
                ? ` Убрала перенесённое из **${stripped}** ячеек «${fillFromColumn}».`
                : '';
        return {
            ok: true,
            handled: true,
            command,
            affectedRows: filled,
            assistantMessage: `Заполнила «${targetColumn}»: **${filled}** строк.${stripNote}`,
        };
    }

    if (command.action === 'duplicate_column') {
        const sourceCol = command.sourceColumn;
        const newName = command.newColumnName;
        if (!sourceCol) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: formatColumnNotFoundMessage(headers, command.rawColumnHint),
            };
        }
        if (!newName) {
            return {
                ok: true,
                handled: true,
                command,
                assistantMessage: 'Укажи имя копии, например: «скопируй колонку ОС как ОС копия».',
            };
        }
        const duped = await store.duplicateColumn(snapshotId, sourceCol, newName);
        if (!duped.ok) {
            return { ok: true, handled: true, command, assistantMessage: duped.error };
        }
        await store.logOperation(snapshotId, message, command, duped.affected);
        return {
            ok: true,
            handled: true,
            command,
            headers: duped.headers,
            newColumns: [newName],
            affectedRows: duped.affected,
            assistantMessage: `Скопировала «${sourceCol}» → «${newName}» (${duped.affected} строк).`,
        };
    }

    if (actionNeedsSourceColumn(command.action) && !command.sourceColumn) {
        return {
            ok: true,
            handled: true,
            command,
            assistantMessage: formatColumnNotFoundMessage(headers, command.rawColumnHint),
        };
    }

    if (command.action === 'extract' || command.action === 'clean_source') {
        const fields =
            command.extractFields?.length > 0
                ? command.extractFields
                : inferExtractFieldsFromMessage(message);
        const stripTargets = stripTargetsFromFields(fields);
        const doStrip = command.action === 'clean_source' || command.stripFromSource;
        const onlyClean = command.action === 'clean_source';
        let affected = 0;
        let filled = 0;
        const previewSample = [];
        const newColSet = new Set(onlyClean ? [] : fields.map((f) => f.target_column));

        await store.fetchAllRowsBatched(snapshotId, PROCESS_BATCH, async (batch) => {
            const updates = [];
            for (const { rowIndex, data } of batch) {
                const text = String(data[command.sourceColumn] ?? '');
                const extracted = applyExtractFields(text, fields);
                const patch = onlyClean ? {} : { ...extracted };
                if (!onlyClean && Object.keys(extracted).length) filled += 1;
                if (doStrip && command.sourceColumn) {
                    patch[command.sourceColumn] = stripExtractedFromText(text, stripTargets);
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
            ? filled > 0
                ? `Добавила колонки: ${newCols.join(', ')} (заполнила ${filled} из ${snap.rowCount} строк). Прокрути таблицу вправо.`
                : `Колонки ${newCols.join(', ')} добавила, но номер в «${command.sourceColumn}» не нашла ни в одной строке.`
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
