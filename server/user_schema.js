/** Пользователи, активность, owner_user_id на projects/trades. */
const { hashPassword } = require('./auth_password');
const { resolveAuditor } = require('./auditor_context');

const USER_DDL = `
    CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        full_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'auditor' CHECK (role IN ('boss', 'auditor')),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        last_login_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_events (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        entity_type TEXT,
        entity_id INTEGER,
        meta JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_activity_events_user ON activity_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_activity_events_created ON activity_events(created_at DESC);

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_owner_user ON projects(owner_user_id);

    ALTER TABLE trades ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_trades_owner_user ON trades(owner_user_id);

    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
`;

function mapUserRow(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        role: row.role,
        isActive: row.is_active,
        createdBy: row.created_by,
        lastLoginAt: row.last_login_at,
        createdAt: row.created_at,
    };
}

async function getUserById(pool, id) {
    const res = await pool.query(
        `SELECT id, email, full_name, role, is_active, created_by, last_login_at, created_at
         FROM users WHERE id = $1`,
        [id]
    );
    return mapUserRow(res.rows[0]);
}

async function getUserByEmail(pool, email) {
    const res = await pool.query(
        `SELECT id, email, password_hash, full_name, role, is_active, created_by, last_login_at, created_at
         FROM users WHERE LOWER(email) = LOWER($1)`,
        [String(email || '').trim()]
    );
    const row = res.rows[0];
    if (!row) return null;
    return { ...mapUserRow(row), passwordHash: row.password_hash };
}

async function ensureUserProject(pool, userId, name) {
    const existing = await pool.query(
        `SELECT id, name FROM projects WHERE owner_user_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [userId]
    );
    if (existing.rows[0]) {
        return { projectId: existing.rows[0].id, projectName: existing.rows[0].name };
    }
    const auditor = await resolveAuditor(pool, 'martin');
    const auditorId = auditor?.id || null;
    const label = name || 'Рабочий стол';
    const created = await pool.query(
        `INSERT INTO projects (name, auditor_id, owner_user_id) VALUES ($1, $2, $3) RETURNING id, name`,
        [label, auditorId, userId]
    );
    return { projectId: created.rows[0].id, projectName: created.rows[0].name };
}

async function seedUserIfMissing(pool, { email, password, fullName, role, createdBy = null }) {
    const norm = String(email || '').trim().toLowerCase();
    if (!norm || !password) return null;
    const existing = await getUserByEmail(pool, norm);
    if (existing) return existing;
    const res = await pool.query(
        `INSERT INTO users (email, password_hash, full_name, role, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, full_name, role, is_active, created_by, last_login_at, created_at`,
        [norm, hashPassword(password), fullName || norm, role, createdBy]
    );
    const user = mapUserRow(res.rows[0]);
    if (user.role === 'auditor') {
        await ensureUserProject(pool, user.id, `Рабочий стол — ${user.fullName || user.email}`);
    }
    return user;
}

async function migrateOrphanProjects(pool, defaultUserId) {
    if (!defaultUserId) return;
    await pool.query(
        `UPDATE projects SET owner_user_id = $1 WHERE owner_user_id IS NULL`,
        [defaultUserId]
    );
}

async function ensureUsersSchema(pool) {
    await pool.query(USER_DDL);

    const bossEmail = String(process.env.BOSS_SEED_EMAIL || 'boss@bankfuture.ru').trim().toLowerCase();
    const bossPassword = String(process.env.BOSS_SEED_PASSWORD || process.env.DEMO_AUTH_PASSWORD || 'demo');
    const demoEmail = String(process.env.DEMO_AUTH_EMAIL || 'demo@bankfuture.ru').trim().toLowerCase();
    const demoPassword = String(process.env.DEMO_AUTH_PASSWORD || 'demo');

    const boss = await seedUserIfMissing(pool, {
        email: bossEmail,
        password: bossPassword,
        fullName: 'Руководитель',
        role: 'boss',
    });

    const demo = await seedUserIfMissing(pool, {
        email: demoEmail,
        password: demoPassword,
        fullName: 'Демо аудитор',
        role: 'auditor',
        createdBy: boss?.id || null,
    });

    if (demo?.id) {
        await migrateOrphanProjects(pool, demo.id);
        await ensureUserProject(pool, demo.id);
    }
}

module.exports = {
    USER_DDL,
    ensureUsersSchema,
    getUserById,
    getUserByEmail,
    ensureUserProject,
    seedUserIfMissing,
    mapUserRow,
};
