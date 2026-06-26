/**
 * Единый пул PostgreSQL для API и миграций.
 * Immerse / Docker / локально: DATABASE_URL или DB_HOST+DB_PORT+DB_NAME+DB_USER+DB_PASSWORD.
 */
const { Pool } = require('pg');

function buildPoolConfig() {
    const url = String(process.env.DATABASE_URL || '').trim();
    if (url) {
        return {
            connectionString: url,
            ssl: process.env.DB_SSL === '1' ? { rejectUnauthorized: false } : undefined,
            max: parseInt(process.env.DB_POOL_MAX || '20', 10) || 20,
            idleTimeoutMillis: 30000,
        };
    }
    return {
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10) || 5432,
        database: process.env.DB_NAME || 'auditor',
        user: process.env.DB_USER || 'postgres',
        password: String(process.env.DB_PASSWORD || ''),
        max: parseInt(process.env.DB_POOL_MAX || '20', 10) || 20,
        idleTimeoutMillis: 30000,
    };
}

let sharedPool = null;

function createPool() {
    return new Pool(buildPoolConfig());
}

function getPool() {
    if (!sharedPool) sharedPool = createPool();
    return sharedPool;
}

module.exports = { createPool, getPool, buildPoolConfig };
