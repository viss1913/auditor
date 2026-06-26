const { fixMojibakeUtf8 } = require('./fix_upload_filename');
const { buildFilterDeleteQuery, rowMatchesFilters, sanitizeFilterPlan } = require('./table_row_filter');
const { inferTableMeta } = require('./table_meta');

const BATCH_INSERT_SIZE = 1500;
const MAX_PAGE_LIMIT = 500;

function sanitizeForJsonb(value) {
    if (value == null) return value;
    if (typeof value === 'string') {
        return value.replace(/\u0000/g, '');
    }
    if (Array.isArray(value)) return value.map(sanitizeForJsonb);
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = sanitizeForJsonb(v);
        }
        return out;
    }
    return value;
}

function createParseSnapshotStore(pool) {
    async function createSnapshot(meta) {
        const {
            projectId = null,
            sourceFileName = null,
            sheetName = null,
            scenarioId = null,
            ruleId = null,
            headers = [],
            tableMeta = null,
            status = 'parsing',
        } = meta;
        const resolvedMeta = tableMeta || {};
        const res = await pool.query(
            `INSERT INTO parse_snapshots (
                project_id, source_file_name, sheet_name, scenario_id, rule_id,
                headers, table_meta, row_count, status
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 0, $8)
            RETURNING id`,
            [
                projectId,
                sourceFileName,
                sheetName,
                scenarioId,
                ruleId,
                JSON.stringify(headers),
                JSON.stringify(resolvedMeta),
                status,
            ]
        );
        return res.rows[0].id;
    }

    async function setSnapshotStatus(snapshotId, status, { rowCount, errorMessage } = {}) {
        await pool.query(
            `UPDATE parse_snapshots
             SET status = $2,
                 row_count = COALESCE($3, row_count),
                 error_message = $4
             WHERE id = $1`,
            [snapshotId, status, rowCount ?? null, errorMessage ?? null]
        );
    }

    async function insertRowsBatch(snapshotId, rows, startIndex = 0) {
        if (!rows.length) return 0;
        let inserted = 0;
        for (let i = 0; i < rows.length; i += BATCH_INSERT_SIZE) {
            const chunk = rows.slice(i, i + BATCH_INSERT_SIZE);
            const values = [];
            const params = [];
            let p = 1;
            for (let j = 0; j < chunk.length; j++) {
                const rowIndex = startIndex + i + j;
                values.push(`($${p}, $${p + 1}, $${p + 2}::jsonb)`);
                params.push(snapshotId, rowIndex, JSON.stringify(sanitizeForJsonb(chunk[j])));
                p += 3;
            }
            await pool.query(
                `INSERT INTO parsed_rows (snapshot_id, row_index, data) VALUES ${values.join(', ')}
                 ON CONFLICT (snapshot_id, row_index) DO UPDATE SET data = EXCLUDED.data`,
                params
            );
            inserted += chunk.length;
        }
        return inserted;
    }

    async function importParsedRows(snapshotId, headers, rows, tableMeta = null) {
        if (tableMeta) {
            await pool.query(`UPDATE parse_snapshots SET table_meta = $2::jsonb WHERE id = $1`, [
                snapshotId,
                JSON.stringify(tableMeta),
            ]);
        }
        await pool.query(
            `UPDATE parse_snapshots SET headers = $2::jsonb WHERE id = $1`,
            [snapshotId, JSON.stringify(headers)]
        );
        const count = await insertRowsBatch(snapshotId, rows, 0);
        await setSnapshotStatus(snapshotId, 'ready', { rowCount: count });
        return count;
    }

    async function appendParsedRows(snapshotId, rows) {
        if (!rows?.length) {
            const snap = await getSnapshot(snapshotId);
            return { added: 0, rowCount: snap?.rowCount ?? 0 };
        }
        const res = await pool.query(
            `SELECT COALESCE(MAX(row_index), -1)::int AS max_idx FROM parsed_rows WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const startIndex = (res.rows[0]?.max_idx ?? -1) + 1;
        const added = await insertRowsBatch(snapshotId, rows, startIndex);
        const countRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM parsed_rows WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const rowCount = countRes.rows[0]?.c ?? added;
        await setSnapshotStatus(snapshotId, 'ready', { rowCount });
        return { added, rowCount };
    }

    async function getSnapshot(snapshotId) {
        const res = await pool.query(`SELECT * FROM parse_snapshots WHERE id = $1`, [snapshotId]);
        if (!res.rows.length) return null;
        const row = res.rows[0];
        return {
            id: row.id,
            projectId: row.project_id,
            sourceFileName: fixMojibakeUtf8(row.source_file_name),
            sheetName: fixMojibakeUtf8(row.sheet_name),
            scenarioId: row.scenario_id,
            ruleId: row.rule_id,
            headers: row.headers || [],
            tableMeta: inferTableMeta(
                row.headers || [],
                row.scenario_id,
                row.table_meta && Object.keys(row.table_meta).length ? row.table_meta : null
            ),
            rowCount: row.row_count,
            status: row.status,
            errorMessage: row.error_message,
            createdAt: row.created_at,
        };
    }

    async function fetchRowsPage(snapshotId, { page = 1, limit = 200 } = {}) {
        const safeLimit = Math.min(Math.max(1, limit), MAX_PAGE_LIMIT);
        const safePage = Math.max(1, page);
        const offset = (safePage - 1) * safeLimit;

        const snap = await getSnapshot(snapshotId);
        if (!snap) return null;

        const countRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM parsed_rows WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const total = countRes.rows[0].c;

        const res = await pool.query(
            `SELECT row_index, data FROM parsed_rows
             WHERE snapshot_id = $1
             ORDER BY row_index ASC
             LIMIT $2 OFFSET $3`,
            [snapshotId, safeLimit, offset]
        );

        const rows = res.rows.map((r) => ({ ...r.data, __rowIndex: r.row_index }));
        return {
            rows,
            total,
            page: safePage,
            limit: safeLimit,
            headers: snap.headers,
            tableMeta: snap.tableMeta,
            scenarioId: snap.scenarioId,
        };
    }

    async function updateRowsBatch(snapshotId, updates) {
        if (!updates.length) return 0;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const u of updates) {
                await client.query(
                    `UPDATE parsed_rows SET data = data || $3::jsonb
                     WHERE snapshot_id = $1 AND row_index = $2`,
                    [snapshotId, u.rowIndex, JSON.stringify(u.patch)]
                );
            }
            await client.query('COMMIT');
            return updates.length;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async function replaceRowsBatch(snapshotId, updates) {
        if (!updates.length) return 0;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            for (const u of updates) {
                await client.query(
                    `UPDATE parsed_rows SET data = $3::jsonb
                     WHERE snapshot_id = $1 AND row_index = $2`,
                    [snapshotId, u.rowIndex, JSON.stringify(u.data)]
                );
            }
            await client.query('COMMIT');
            return updates.length;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    async function deleteSnapshot(snapshotId) {
        await pool.query(`DELETE FROM parse_snapshots WHERE id = $1`, [snapshotId]);
    }

    async function fetchAllRowsBatched(snapshotId, batchSize, onBatch) {
        let offset = 0;
        let total = 0;
        while (true) {
            const res = await pool.query(
                `SELECT row_index, data FROM parsed_rows
                 WHERE snapshot_id = $1
                 ORDER BY row_index ASC
                 LIMIT $2 OFFSET $3`,
                [snapshotId, batchSize, offset]
            );
            if (!res.rows.length) break;
            const batch = res.rows.map((r) => ({
                rowIndex: r.row_index,
                data: r.data,
            }));
            await onBatch(batch);
            total += batch.length;
            offset += batch.length;
            if (res.rows.length < batchSize) break;
        }
        return total;
    }

    async function getDistinctColumnValues(snapshotId, columnName, maxValues = 5000) {
        const res = await pool.query(
            `SELECT DISTINCT data->>$2 AS val
             FROM parsed_rows
             WHERE snapshot_id = $1 AND data->>$2 IS NOT NULL AND TRIM(data->>$2) <> ''
             LIMIT $3`,
            [snapshotId, columnName, maxValues]
        );
        return res.rows.map((r) => r.val);
    }

    async function copyRowsToNewSnapshot(sourceSnapshotId, { plan, label } = {}) {
        const snap = await getSnapshot(sourceSnapshotId);
        if (!snap) return null;

        const sanitized = sanitizeFilterPlan(plan, snap.headers || []);
        const tableLabel = String(label || 'выборка').trim() || 'выборка';

        const newId = await createSnapshot({
            projectId: snap.projectId,
            sourceFileName: snap.sourceFileName,
            sheetName: tableLabel,
            scenarioId: snap.scenarioId,
            ruleId: snap.ruleId,
            headers: snap.headers || [],
            status: 'parsing',
        });

        const matchingRows = [];
        await fetchAllRowsBatched(sourceSnapshotId, BATCH_INSERT_SIZE, async (batch) => {
            for (const { data } of batch) {
                const match = rowMatchesFilters(data, sanitized);
                const keep = sanitized.mode === 'keep' ? match : !match;
                if (keep) matchingRows.push({ ...data });
            }
        });

        if (matchingRows.length) {
            await importParsedRows(newId, snap.headers || [], matchingRows);
        } else {
            await setSnapshotStatus(newId, 'ready', { rowCount: 0 });
        }

        return {
            newSnapshotId: newId,
            rowCount: matchingRows.length,
            sourceRowCount: snap.rowCount,
            plan: sanitized,
            tableLabel,
        };
    }

    async function filterRows(snapshotId, plan) {
        const snap = await getSnapshot(snapshotId);
        const headers = snap?.headers || [];

        const countBeforeRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM parsed_rows WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const before = countBeforeRes.rows[0]?.c ?? 0;

        const { sql, params, plan: sanitized } = buildFilterDeleteQuery(snapshotId, plan, headers);
        if (!sql) {
            if (!sanitized.filters?.length) {
                return { before, after: before, removed: 0, plan: sanitized };
            }
            const toDelete = [];
            await fetchAllRowsBatched(snapshotId, BATCH_INSERT_SIZE, async (batch) => {
                for (const { rowIndex, data } of batch) {
                    const match = rowMatchesFilters(data, sanitized);
                    const drop = sanitized.mode === 'keep' ? !match : match;
                    if (drop) toDelete.push(rowIndex);
                }
            });
            if (toDelete.length) {
                await pool.query(
                    `DELETE FROM parsed_rows WHERE snapshot_id = $1 AND row_index = ANY($2::int[])`,
                    [snapshotId, toDelete]
                );
            }
            const after = Math.max(0, before - toDelete.length);
            await pool.query(`UPDATE parse_snapshots SET row_count = $2 WHERE id = $1`, [
                snapshotId,
                after,
            ]);
            return { before, after, removed: toDelete.length, plan: sanitized };
        }

        const delRes = await pool.query(sql, params);
        const removed = delRes.rowCount ?? 0;
        const after = Math.max(0, before - removed);

        await pool.query(`UPDATE parse_snapshots SET row_count = $2 WHERE id = $1`, [snapshotId, after]);

        return { before, after, removed, plan: sanitized };
    }

    async function getLastTableOperation(snapshotId, action = null) {
        const params = [snapshotId];
        let sql = `SELECT message, command_json, rows_affected, created_at
                   FROM table_operations WHERE snapshot_id = $1`;
        if (action) {
            sql += ` AND command_json->>'action' = $2`;
            params.push(action);
        }
        sql += ` ORDER BY created_at DESC LIMIT 1`;
        const res = await pool.query(sql, params);
        if (!res.rows.length) return null;
        const row = res.rows[0];
        return {
            message: row.message,
            command: row.command_json || {},
            rowsAffected: row.rows_affected,
            createdAt: row.created_at,
        };
    }

    async function logOperation(snapshotId, message, commandJson, rowsAffected, rollbackPayload = null) {
        await pool.query(
            `INSERT INTO table_operations (snapshot_id, message, command_json, rows_affected, rollback_payload)
             VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)`,
            [
                snapshotId,
                message,
                JSON.stringify(commandJson || {}),
                rowsAffected || 0,
                rollbackPayload ? JSON.stringify(rollbackPayload) : null,
            ]
        );
    }

    async function restoreRowsAtIndices(snapshotId, rows) {
        if (!rows?.length) return 0;
        let restored = 0;
        for (let i = 0; i < rows.length; i += BATCH_INSERT_SIZE) {
            const chunk = rows.slice(i, i + BATCH_INSERT_SIZE);
            const values = [];
            const params = [];
            let p = 1;
            for (const row of chunk) {
                values.push(`($${p}, $${p + 1}, $${p + 2}::jsonb)`);
                params.push(snapshotId, row.rowIndex, JSON.stringify(sanitizeForJsonb(row.data)));
                p += 3;
            }
            await pool.query(
                `INSERT INTO parsed_rows (snapshot_id, row_index, data) VALUES ${values.join(', ')}
                 ON CONFLICT (snapshot_id, row_index) DO UPDATE SET data = EXCLUDED.data`,
                params
            );
            restored += chunk.length;
        }
        const countRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM parsed_rows WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const rowCount = countRes.rows[0]?.c ?? restored;
        await setSnapshotStatus(snapshotId, 'ready', { rowCount });
        return restored;
    }

    async function collectRowsToDelete(snapshotId, plan) {
        const snap = await getSnapshot(snapshotId);
        const sanitized = sanitizeFilterPlan(plan, snap?.headers || []);
        const deletedRows = [];
        await fetchAllRowsBatched(snapshotId, BATCH_INSERT_SIZE, async (batch) => {
            for (const { rowIndex, data } of batch) {
                const match = rowMatchesFilters(data, sanitized);
                const drop = sanitized.mode === 'keep' ? !match : match;
                if (drop) deletedRows.push({ rowIndex, data });
            }
        });
        return { deletedRows, plan: sanitized };
    }

    async function reorderColumns(snapshotId, fromColumn, anchorColumn, position = 'after') {
        const snap = await getSnapshot(snapshotId);
        if (!snap) return { ok: false, error: 'Снимок не найден' };
        const headers = [...(snap.headers || [])];
        const fromIdx = headers.indexOf(fromColumn);
        const anchorIdx = headers.indexOf(anchorColumn);
        if (fromIdx < 0) return { ok: false, error: `Колонка «${fromColumn}» не найдена` };
        if (anchorIdx < 0) return { ok: false, error: `Колонка «${anchorColumn}» не найдена` };

        headers.splice(fromIdx, 1);
        const newAnchorIdx = headers.indexOf(anchorColumn);
        const insertAt = position === 'before' ? newAnchorIdx : newAnchorIdx + 1;
        headers.splice(insertAt, 0, fromColumn);

        await pool.query(`UPDATE parse_snapshots SET headers = $2::jsonb WHERE id = $1`, [
            snapshotId,
            JSON.stringify(headers),
        ]);
        return { ok: true, headers };
    }

    async function renameColumn(snapshotId, oldName, newName) {
        const snap = await getSnapshot(snapshotId);
        if (!snap) return { ok: false, error: 'Снимок не найден' };
        if (!snap.headers.includes(oldName)) {
            return { ok: false, error: `Колонка «${oldName}» не найдена` };
        }
        if (snap.headers.includes(newName)) {
            return { ok: false, error: `Колонка «${newName}» уже есть` };
        }

        const headers = snap.headers.map((h) => (h === oldName ? newName : h));
        let affected = 0;

        await fetchAllRowsBatched(snapshotId, BATCH_INSERT_SIZE, async (batch) => {
            const updates = [];
            for (const { rowIndex, data } of batch) {
                if (!Object.prototype.hasOwnProperty.call(data, oldName)) continue;
                const next = { ...data };
                next[newName] = next[oldName];
                delete next[oldName];
                updates.push({ rowIndex, data: next });
            }
            if (updates.length) {
                await replaceRowsBatch(snapshotId, updates);
                affected += updates.length;
            }
        });

        await pool.query(`UPDATE parse_snapshots SET headers = $2::jsonb WHERE id = $1`, [
            snapshotId,
            JSON.stringify(headers),
        ]);
        return { ok: true, headers, affected, oldName, newName };
    }

    async function addColumn(snapshotId, columnName, defaultValue = '', positionOpts = null) {
        const snap = await getSnapshot(snapshotId);
        if (!snap) return { ok: false, error: 'Снимок не найден' };
        if (!columnName) return { ok: false, error: 'Имя колонки пустое' };
        if (snap.headers.includes(columnName)) {
            return { ok: false, error: `Колонка «${columnName}» уже есть` };
        }

        const afterColumn = positionOpts?.afterColumn;
        const position = positionOpts?.position === 'before' ? 'before' : 'after';
        const headers = [...snap.headers];
        if (afterColumn && headers.includes(afterColumn)) {
            const idx = headers.indexOf(afterColumn);
            const insertAt = position === 'before' ? idx : idx + 1;
            headers.splice(insertAt, 0, columnName);
        } else {
            headers.push(columnName);
        }
        let affected = 0;

        await fetchAllRowsBatched(snapshotId, BATCH_INSERT_SIZE, async (batch) => {
            const updates = [];
            for (const { rowIndex, data } of batch) {
                updates.push({ rowIndex, patch: { [columnName]: defaultValue } });
            }
            if (updates.length) {
                await updateRowsBatch(snapshotId, updates);
                affected += updates.length;
            }
        });

        await pool.query(`UPDATE parse_snapshots SET headers = $2::jsonb WHERE id = $1`, [
            snapshotId,
            JSON.stringify(headers),
        ]);
        return { ok: true, headers, affected, columnName };
    }

    async function duplicateColumn(snapshotId, sourceColumn, newColumn) {
        const snap = await getSnapshot(snapshotId);
        if (!snap) return { ok: false, error: 'Снимок не найден' };
        if (!snap.headers.includes(sourceColumn)) {
            return { ok: false, error: `Колонка «${sourceColumn}» не найдена` };
        }
        if (snap.headers.includes(newColumn)) {
            return { ok: false, error: `Колонка «${newColumn}» уже есть` };
        }

        const sourceIdx = snap.headers.indexOf(sourceColumn);
        const headers = [...snap.headers];
        headers.splice(sourceIdx + 1, 0, newColumn);
        let affected = 0;

        await fetchAllRowsBatched(snapshotId, BATCH_INSERT_SIZE, async (batch) => {
            const updates = [];
            for (const { rowIndex, data } of batch) {
                updates.push({ rowIndex, patch: { [newColumn]: data[sourceColumn] ?? '' } });
            }
            if (updates.length) {
                await updateRowsBatch(snapshotId, updates);
                affected += updates.length;
            }
        });

        await pool.query(`UPDATE parse_snapshots SET headers = $2::jsonb WHERE id = $1`, [
            snapshotId,
            JSON.stringify(headers),
        ]);
        return { ok: true, headers, affected, sourceColumn, newColumn };
    }

    async function collectColumnValues(snapshotId, columnName) {
        const rows = [];
        await fetchAllRowsBatched(snapshotId, BATCH_INSERT_SIZE, async (batch) => {
            for (const { rowIndex, data } of batch) {
                if (Object.prototype.hasOwnProperty.call(data, columnName)) {
                    rows.push({ rowIndex, value: data[columnName] });
                }
            }
        });
        return rows;
    }

    async function getLastOperation(snapshotId) {
        const res = await pool.query(
            `SELECT id, message, command_json, rows_affected, rollback_payload, created_at
             FROM table_operations WHERE snapshot_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [snapshotId]
        );
        if (!res.rows.length) return null;
        const row = res.rows[0];
        return {
            id: row.id,
            message: row.message,
            command: row.command_json || {},
            rowsAffected: row.rows_affected,
            rollbackPayload: row.rollback_payload || null,
            createdAt: row.created_at,
        };
    }

    async function appendChatMessage({ projectId, snapshotId, role, content, toolCalls }) {
        await pool.query(
            `INSERT INTO chat_history (project_id, snapshot_id, role, content, tool_calls)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
                projectId ?? null,
                snapshotId ?? null,
                role,
                content,
                toolCalls ? JSON.stringify(toolCalls) : null,
            ]
        );
    }

    async function saveRecipe(projectId, name, recipeJson) {
        const res = await pool.query(
            `INSERT INTO table_recipes (project_id, name, recipe_json)
             VALUES ($1, $2, $3::jsonb) RETURNING id`,
            [projectId, name, JSON.stringify(recipeJson)]
        );
        return res.rows[0].id;
    }

    async function listRecipes(projectId) {
        const res = await pool.query(
            `SELECT id, name, recipe_json, created_at FROM table_recipes
             WHERE project_id = $1 ORDER BY created_at DESC`,
            [projectId]
        );
        return res.rows;
    }

    const api = {
        pool,
        createSnapshot,
        setSnapshotStatus,
        insertRowsBatch,
        importParsedRows,
        appendParsedRows,
        getSnapshot,
        fetchRowsPage,
        updateRowsBatch,
        replaceRowsBatch,
        deleteSnapshot,
        fetchAllRowsBatched,
        getDistinctColumnValues,
        filterRows,
        copyRowsToNewSnapshot,
        getLastTableOperation,
        getLastOperation,
        logOperation,
        restoreRowsAtIndices,
        collectRowsToDelete,
        reorderColumns,
        renameColumn,
        addColumn,
        duplicateColumn,
        collectColumnValues,
        appendChatMessage,
        saveRecipe,
        listRecipes,
        BATCH_INSERT_SIZE,
        MAX_PAGE_LIMIT,
    };
    return api;
}

module.exports = { createParseSnapshotStore, BATCH_INSERT_SIZE, MAX_PAGE_LIMIT };
