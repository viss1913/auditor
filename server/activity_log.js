async function logActivity(pool, { userId, action, entityType = null, entityId = null, meta = {} }) {
    if (!pool || !action) return;
    try {
        await pool.query(
            `INSERT INTO activity_events (user_id, action, entity_type, entity_id, meta)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [userId ?? null, action, entityType, entityId ?? null, JSON.stringify(meta || {})]
        );
    } catch (err) {
        console.warn('[activity_log]', err.message);
    }
}

module.exports = { logActivity };
