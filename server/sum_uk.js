const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const pool = new Pool({
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: String(process.env.DB_PASSWORD),
});

pool.query(`
    SELECT 
        source,
        COUNT(*) as cnt,
        SUM(amount::numeric) as total
    FROM trades
    WHERE source = 'UK'
    GROUP BY source
`).then(r => {
    const row = r.rows[0];
    if (!row) { console.log('Нет данных в УК'); return; }
    const total = parseFloat(row.total);
    console.log(`Записей в УК: ${row.cnt}`);
    console.log(`Сумма всех сделок: ${total.toLocaleString('ru-RU', { minimumFractionDigits: 2 })} руб.`);
    pool.end();
}).catch(e => { console.error(e.message); process.exit(1); });
