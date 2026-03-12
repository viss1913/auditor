require('dotenv').config({ path: '../.env' }); // or wherever env is, let's just use the pool if it relies on process.env
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'auditor',
    password: process.env.DB_PASSWORD || '1qazXSW@',
    port: process.env.DB_PORT || 5432,
});

const migrate = async () => {
    try {
        console.log('Начинаю создание таблиц...');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS projects (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Таблица projects проверена/создана.');

        try {
            await pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS project_id INTEGER REFERENCES projects(id);`);
            console.log('Колонка project_id добавлена в trades.');
        } catch (e) {
            console.log('Колонка project_id уже существует или ошибка:', e.message);
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS parsing_rules (
                id SERIAL PRIMARY KEY,
                project_id INTEGER REFERENCES projects(id),
                source TEXT,
                rule_json JSONB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        console.log('Таблица parsing_rules проверена/создана.');

        console.log('Миграция успешно завершена!');
    } catch (err) {
        console.error('Ошибка миграции:', err);
    } finally {
        await pool.end();
    }
};

migrate();
