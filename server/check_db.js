const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' });

const pool = new Pool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
});

pool.query('SELECT COUNT(*) FROM trades', (err, res) => {
    if (err) {
        console.error('Ошибка:', err.message);
    } else {
        console.log('Итого строк в базе:', res.rows[0].count);
    }
    pool.end();
});
