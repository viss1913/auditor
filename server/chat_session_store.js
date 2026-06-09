const { fixMojibakeUtf8 } = require('./fix_upload_filename');

function createChatSessionStore(pool) {
    async function createChatSession(projectId, title = 'Новый чат') {
        const res = await pool.query(
            `INSERT INTO chat_sessions (project_id, title) VALUES ($1, $2) RETURNING *`,
            [projectId, title]
        );
        return mapChatRow(res.rows[0]);
    }

    async function listChatSessions(projectId) {
        const res = await pool.query(
            `SELECT cs.*,
                    COUNT(css.id) FILTER (WHERE css.removed_at IS NULL)::int AS table_count
             FROM chat_sessions cs
             LEFT JOIN chat_session_snapshots css ON css.chat_session_id = cs.id
             WHERE cs.project_id = $1
             GROUP BY cs.id
             ORDER BY cs.updated_at DESC, cs.id DESC`,
            [projectId]
        );
        return res.rows.map(mapChatRow);
    }

    async function getChatSession(chatSessionId) {
        const res = await pool.query(`SELECT * FROM chat_sessions WHERE id = $1`, [chatSessionId]);
        if (!res.rows.length) return null;
        return mapChatRow(res.rows[0]);
    }

    async function touchChatSession(chatSessionId) {
        await pool.query(
            `UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [chatSessionId]
        );
    }

    async function updateChatTitle(chatSessionId, title) {
        const res = await pool.query(
            `UPDATE chat_sessions SET title = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
            [chatSessionId, title]
        );
        return res.rows[0] ? mapChatRow(res.rows[0]) : null;
    }

    async function linkSnapshot(chatSessionId, snapshotId, label = null) {
        const countRes = await pool.query(
            `SELECT COUNT(*)::int AS c FROM chat_session_snapshots
             WHERE chat_session_id = $1 AND removed_at IS NULL`,
            [chatSessionId]
        );
        const sortOrder = countRes.rows[0].c;
        const res = await pool.query(
            `INSERT INTO chat_session_snapshots (chat_session_id, snapshot_id, label, sort_order)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (chat_session_id, snapshot_id)
             DO UPDATE SET removed_at = NULL, label = COALESCE(EXCLUDED.label, chat_session_snapshots.label),
                           sort_order = EXCLUDED.sort_order
             RETURNING *`,
            [chatSessionId, snapshotId, label, sortOrder]
        );
        await touchChatSession(chatSessionId);
        return mapLinkRow(res.rows[0]);
    }

    async function unlinkSnapshot(chatSessionId, snapshotId, { hardDeleteSnapshot = false } = {}) {
        await pool.query(
            `UPDATE chat_session_snapshots SET removed_at = CURRENT_TIMESTAMP
             WHERE chat_session_id = $1 AND snapshot_id = $2`,
            [chatSessionId, snapshotId]
        );
        if (hardDeleteSnapshot) {
            await pool.query(`DELETE FROM parse_snapshots WHERE id = $1`, [snapshotId]);
        }
        await touchChatSession(chatSessionId);
    }

    async function listChatSnapshots(chatSessionId) {
        const res = await pool.query(
            `SELECT css.*,
                    ps.source_file_name, ps.sheet_name, ps.scenario_id,
                    ps.row_count, ps.status, ps.created_at AS snapshot_created_at
             FROM chat_session_snapshots css
             JOIN parse_snapshots ps ON ps.id = css.snapshot_id
             WHERE css.chat_session_id = $1 AND css.removed_at IS NULL
             ORDER BY css.sort_order ASC, css.id ASC`,
            [chatSessionId]
        );
        return res.rows.map((row) => ({
            id: row.id,
            chatSessionId: row.chat_session_id,
            snapshotId: row.snapshot_id,
            label: fixMojibakeUtf8(row.label),
            sortOrder: row.sort_order,
            sourceFileName: fixMojibakeUtf8(row.source_file_name),
            sheetName: fixMojibakeUtf8(row.sheet_name),
            scenarioId: row.scenario_id,
            rowCount: row.row_count,
            status: row.status,
            snapshotCreatedAt: row.snapshot_created_at,
        }));
    }

    async function getChatMessages(chatSessionId, limit = 200) {
        const res = await pool.query(
            `SELECT id, role, content, snapshot_id, created_at
             FROM chat_history
             WHERE chat_session_id = $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [chatSessionId, limit]
        );
        return res.rows.map((row) => ({
            id: row.id,
            role: row.role,
            content: row.content,
            snapshotId: row.snapshot_id,
            createdAt: row.created_at,
        }));
    }

    async function appendChatMessage({ chatSessionId, projectId, snapshotId, role, content, toolCalls }) {
        await pool.query(
            `INSERT INTO chat_history (project_id, chat_session_id, snapshot_id, role, content, tool_calls)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
            [
                projectId ?? null,
                chatSessionId ?? null,
                snapshotId ?? null,
                role,
                content,
                toolCalls ? JSON.stringify(toolCalls) : null,
            ]
        );
        if (chatSessionId) await touchChatSession(chatSessionId);
    }

    function mapChatRow(row) {
        return {
            id: row.id,
            projectId: row.project_id,
            title: fixMojibakeUtf8(row.title),
            tableCount: row.table_count != null ? Number(row.table_count) : undefined,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    function mapLinkRow(row) {
        return {
            id: row.id,
            chatSessionId: row.chat_session_id,
            snapshotId: row.snapshot_id,
            label: row.label,
            sortOrder: row.sort_order,
        };
    }

    async function deleteChatSession(chatSessionId) {
        await pool.query(`DELETE FROM chat_sessions WHERE id = $1`, [chatSessionId]);
    }

    async function deleteAllChatSessions(projectId) {
        await pool.query(`DELETE FROM chat_sessions WHERE project_id = $1`, [projectId]);
    }

    return {
        createChatSession,
        listChatSessions,
        getChatSession,
        touchChatSession,
        updateChatTitle,
        linkSnapshot,
        unlinkSnapshot,
        listChatSnapshots,
        getChatMessages,
        appendChatMessage,
        deleteChatSession,
        deleteAllChatSessions,
    };
}

module.exports = { createChatSessionStore };
