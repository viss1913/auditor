const { resolveAuditor } = require('./auditor_context');
const { createChatSessionStore } = require('./chat_session_store');
const { ensureUserProject } = require('./user_schema');

const DEFAULT_PROJECT_NAME = 'Martin';

async function ensureDefaultProject(pool, userId) {
    const uid = parseInt(userId, 10);
    if (!Number.isFinite(uid)) {
        throw new Error('Не указан пользователь для рабочего стола Martin');
    }

    const auditor = await resolveAuditor(pool, 'martin');
    if (!auditor) throw new Error('Аудитор martin не найден — запусти migrate_db');

    const existing = await pool.query(
        `SELECT id, name FROM projects WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [uid]
    );
    if (existing.rows[0]) {
        return { projectId: existing.rows[0].id, projectName: existing.rows[0].name, auditor };
    }

    const created = await pool.query(
        `INSERT INTO projects (name, auditor_id, owner_user_id) VALUES ($1, $2, $3) RETURNING id, name`,
        [DEFAULT_PROJECT_NAME, auditor.id, uid]
    );
    return {
        projectId: created.rows[0].id,
        projectName: created.rows[0].name,
        auditor,
    };
}

async function bootstrapMartinSession(pool, { userId, createChat = false, title = 'Новый чат' } = {}) {
    if (!userId) {
        throw new Error('Требуется авторизованный пользователь');
    }
    await ensureUserProject(pool, userId, DEFAULT_PROJECT_NAME);
    const { projectId, projectName, auditor } = await ensureDefaultProject(pool, userId);
    const chatStore = createChatSessionStore(pool);
    let chats = await chatStore.listChatSessions(projectId);

    let chat = chats[0] || null;
    if (!chat && createChat !== false) {
        chat = await chatStore.createChatSession(projectId, title);
        if (userId) {
            await pool.query(`UPDATE chat_sessions SET created_by_user_id = $1 WHERE id = $2`, [
                userId,
                chat.id,
            ]);
        }
        chats = await chatStore.listChatSessions(projectId);
    }

    return {
        projectId,
        projectName,
        auditorSlug: auditor.slug,
        userId,
        chatSessionId: chat?.id || null,
        chats,
    };
}

module.exports = { ensureDefaultProject, bootstrapMartinSession, DEFAULT_PROJECT_NAME };
