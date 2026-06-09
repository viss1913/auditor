const { Client } = require('pg');

async function main() {
    const admin = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        user: process.env.DB_USER || 'postgres',
        password: String(process.env.DB_PASSWORD || '1qazXSW@'),
        database: 'postgres',
    });

    const dbName = process.env.DB_NAME || 'auditor';

    await admin.connect();
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!exists.rows.length) {
        await admin.query(`CREATE DATABASE ${dbName}`);
        console.log(`Создана БД: ${dbName}`);
    } else {
        console.log(`БД уже есть: ${dbName}`);
    }
    await admin.end();
}

main().catch((e) => {
    console.error('Ошибка БД:', e.message);
    process.exit(1);
});
