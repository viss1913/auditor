class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function getProjectRow(pool, projectId) {
    const id = parseInt(projectId, 10);
    if (!Number.isFinite(id)) return null;
    const res = await pool.query(
        `SELECT id, name, auditor_id, owner_user_id, created_at FROM projects WHERE id = $1`,
        [id]
    );
    return res.rows[0] || null;
}

async function assertProjectAccess(pool, req, projectId) {
    const project = await getProjectRow(pool, projectId);
    if (!project) throw new HttpError(404, 'Проект не найден');
    const user = req.user;
    if (!user) throw new HttpError(401, 'Требуется вход');
    if (user.role === 'boss') return project;
    if (project.owner_user_id == null) {
        throw new HttpError(403, 'Проект не привязан к пользователю');
    }
    if (Number(project.owner_user_id) !== Number(user.id)) {
        throw new HttpError(403, 'Нет доступа к этому проекту');
    }
    return project;
}

async function getSnapshotProjectId(pool, snapshotId) {
    const id = parseInt(snapshotId, 10);
    if (!Number.isFinite(id)) return null;
    const res = await pool.query(`SELECT project_id FROM parse_snapshots WHERE id = $1`, [id]);
    return res.rows[0]?.project_id ?? null;
}

async function assertSnapshotAccess(pool, req, snapshotId) {
    const projectId = await getSnapshotProjectId(pool, snapshotId);
    if (!projectId) throw new HttpError(404, 'Снимок не найден');
    await assertProjectAccess(pool, req, projectId);
    return projectId;
}

async function getChatProjectId(pool, chatId) {
    const id = parseInt(chatId, 10);
    if (!Number.isFinite(id)) return null;
    const res = await pool.query(`SELECT project_id FROM chat_sessions WHERE id = $1`, [id]);
    return res.rows[0]?.project_id ?? null;
}

async function assertChatAccess(pool, req, chatId) {
    const projectId = await getChatProjectId(pool, chatId);
    if (!projectId) throw new HttpError(404, 'Чат не найден');
    await assertProjectAccess(pool, req, projectId);
    return projectId;
}

function sendAccessError(res, err) {
    const status = err?.status || 500;
    res.status(status).json({ error: err.message || 'Ошибка доступа' });
}

function accessGuard(handler) {
    return async (req, res, next) => {
        try {
            await handler(req, res, next);
        } catch (err) {
            if (err instanceof HttpError) return sendAccessError(res, err);
            next(err);
        }
    };
}

module.exports = {
    HttpError,
    getProjectRow,
    assertProjectAccess,
    assertSnapshotAccess,
    assertChatAccess,
    getSnapshotProjectId,
    getChatProjectId,
    sendAccessError,
    accessGuard,
};
