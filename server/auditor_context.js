const DEFAULT_AUDITOR_SLUG = process.env.DEFAULT_AUDITOR_SLUG || 'martin';

function auditorSlugFromRequest(req) {
    const h = String(req.headers['x-auditor-slug'] || req.headers['x-auditor'] || '').trim();
    if (h) return h.toLowerCase();
    const q = String(req.query?.auditor || req.body?.auditorSlug || '').trim();
    if (q) return q.toLowerCase();
    return DEFAULT_AUDITOR_SLUG;
}

async function resolveAuditor(pool, slug) {
    const s = String(slug || DEFAULT_AUDITOR_SLUG).trim().toLowerCase();
    const res = await pool.query(`SELECT id, slug, name FROM auditors WHERE slug = $1`, [s]);
    if (res.rows[0]) return res.rows[0];
    const fallback = await pool.query(`SELECT id, slug, name FROM auditors ORDER BY id LIMIT 1`);
    return fallback.rows[0] || null;
}

async function listAuditors(pool) {
    const res = await pool.query(`SELECT id, slug, name, created_at FROM auditors ORDER BY name`);
    return res.rows;
}

module.exports = {
    DEFAULT_AUDITOR_SLUG,
    auditorSlugFromRequest,
    resolveAuditor,
    listAuditors,
};
