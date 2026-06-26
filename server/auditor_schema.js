/** Аудиторы и привязка проектов (авторизация позже — пока slug в заголовке). */
const AUDITOR_DDL = `
    CREATE TABLE IF NOT EXISTS auditors (
        id SERIAL PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS auditor_id INTEGER REFERENCES auditors(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_auditor ON projects(auditor_id);
`;

const DEFAULT_AUDITORS = [
    { slug: 'martin', name: 'Martin' },
    { slug: 'lyubov', name: 'Любовь — ОПИФ' },
    { slug: 'anton', name: 'Антон — ОС / Martin' },
    { slug: 'kseniya', name: 'Ксения — эталон' },
    { slug: 'pavel', name: 'Павел — договоры' },
];

async function ensureAuditorsSchema(pool) {
    await pool.query(AUDITOR_DDL);
    for (const a of DEFAULT_AUDITORS) {
        await pool.query(
            `INSERT INTO auditors (slug, name) VALUES ($1, $2)
             ON CONFLICT (slug) DO NOTHING`,
            [a.slug, a.name]
        );
    }
    const anton = await pool.query(`SELECT id FROM auditors WHERE slug = 'anton' LIMIT 1`);
    const aid = anton.rows[0]?.id;
    if (aid) {
        await pool.query(`UPDATE projects SET auditor_id = $1 WHERE auditor_id IS NULL`, [aid]);
    }
}

module.exports = { AUDITOR_DDL, DEFAULT_AUDITORS, ensureAuditorsSchema };
