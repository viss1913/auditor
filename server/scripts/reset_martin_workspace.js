#!/usr/bin/env node
/**
 * Сброс Martin: чаты, snapshots, inbox на диске.
 * node scripts/reset_martin_workspace.js [--keep-snapshots]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');
const { ensureAuditorsSchema } = require('../auditor_schema');
const { bootstrapMartinSession } = require('../martin_workspace');

const keepSnapshots = process.argv.includes('--keep-snapshots');
const INBOX_ROOT = process.env.AUDITOR_INBOX_ROOT
    ? path.resolve(process.env.AUDITOR_INBOX_ROOT)
    : path.join(__dirname, '..', 'data', 'inbox');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'auditor',
    password: process.env.DB_PASSWORD || '1qazXSW@',
    port: Number(process.env.DB_PORT || 5432),
});

function rmDirSafe(dir) {
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
}

async function resetDb(client) {
    await client.query('DELETE FROM chat_history');
    await client.query('DELETE FROM chat_session_snapshots');
    await client.query('DELETE FROM chat_sessions');
    if (!keepSnapshots) {
        await client.query('DELETE FROM table_operations');
        await client.query('DELETE FROM parsed_rows');
        await client.query('DELETE FROM parse_snapshots');
    }
}

function resetInboxDisk() {
    const removed = [];
    const martinChats = path.join(INBOX_ROOT, 'martin', 'chats');
    if (rmDirSafe(martinChats)) removed.push(martinChats);
    for (const slug of ['anton', 'lyubov', 'kseniya', 'pavel', 'martin']) {
        const dir = path.join(INBOX_ROOT, slug);
        if (rmDirSafe(dir)) removed.push(dir);
    }
    return removed;
}

(async () => {
    const client = await pool.connect();
    try {
        console.log('Сброс Martin workspace…');
        await resetDb(client);
        await ensureAuditorsSchema(pool);
        const session = await bootstrapMartinSession(pool, { createChat: true, title: 'Новый чат' });
        const removedDirs = resetInboxDisk();
        fs.mkdirSync(path.join(INBOX_ROOT, 'martin', 'chats', `chat-${session.chatSessionId}`), {
            recursive: true,
        });

        console.log('БД: чаты и история очищены' + (keepSnapshots ? ' (snapshots сохранены)' : ', snapshots удалены'));
        console.log('Inbox:', removedDirs.length ? removedDirs.join('\n  ') : '(пусто)');
        console.log('Новый чат:', session.chatSessionId, 'project:', session.projectId);
        console.log('Готово. Обнови страницу Martin (F5).');
    } finally {
        client.release();
        await pool.end();
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
