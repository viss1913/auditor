const { fixMojibakeUtf8 } = require('./fix_upload_filename');
const { buildFilterDeleteQuery } = require('./table_row_filter');

const BATCH_INSERT_SIZE = 1500;
const MAX_PAGE_LIMIT = 500;

function createParseSnapshotStore(pool) {
    async function createSnapshot(meta) {
        const {
            projectId = null,
            sourceFileName = null,
            sheetName = null,
            scenarioId = null,
            ruleId = null,
            headers = [],
            status = 'parsing',
        } = meta;
        const res = await pool.query(
            `INSERT INTO parse_snapshots (
                project_id, source_file_name, sheet_name, scenario_id, rule_id,
                headers, row_count, status
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 0, $7)
            RETURNING id`,
            [
                projectId,
                sourceFileName,
                sheetName,
                scenarioId,
                ruleId,
                JSON.stringify(headers),
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
                params.push(snapshotId, rowIndex, JSON.stringify(chunk[j]));
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

    async function importParsedRows(snapshotId, headers, rows) {
        await pool.query(
            `UPDATE parse_snapshots SET headers = $2::jsonb WHERE id = $1`,
            [snapshotId, JSON.stringify(headers)]
        );
        const count = await insertRowsBatch(snapshotId, rows, 0);
        await setSnapshotStatus(snapshotId, 'ready', { rowCount: count });
        return count;
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

    async function filterRows(snapshotId, plan) {
        const countBeforeRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM parsed_rows WHERE snapshot_id = $1`,
            [snapshotId]
        );
        const before = countBeforeRes.rows[0]?.c ?? 0;

        const { sql, params, plan: sanitized } = buildFilterDeleteQuery(snapshotId, plan);
        if (!sql) {
            return { before, after: before, removed: 0, plan: sanitized };
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

    async function logOperation(snapshotId, message, commandJson, rowsAffected) {
        await pool.query(
            `INSERT INTO table_operations (snapshot_id, message, command_json, rows_affected)
             VALUES ($1, $2, $3::jsonb, $4)`,
            [snapshotId, message, JSON.stringify(commandJson || {}), rowsAffected || 0]
        );
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
        getSnapshot,
        fetchRowsPage,
        updateRowsBatch,
        deleteSnapshot,
        fetchAllRowsBatched,
        getDistinctColumnValues,
        filterRows,
        getLastTableOperation,
        logOperation,
        appendChatMessage,
        saveRecipe,
        listRecipes,
        BATCH_INSERT_SIZE,
        MAX_PAGE_LIMIT,
    };
    return api;
}

module.exports = { createParseSnapshotStore, BATCH_INSERT_SIZE, MAX_PAGE_LIMIT };
