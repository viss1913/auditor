const { Pool } = require('pg');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: 5432,
    database: process.env.DB_NAME || 'auditor',
    user: process.env.DB_USER || 'postgres',
    password: String(process.env.DB_PASSWORD || '1qazXSW@'),
});

async function go() {
    const uk = await pool.query(
        "SELECT registration_date, period::text, quantity FROM trades WHERE source='UK' AND reg_number='1-01-14044-A' ORDER BY period LIMIT 5"
    );
    console.log('=== UK ===');
    uk.rows.forEach(x => console.log(JSON.stringify({ rd: x.registration_date, rdType: typeof x.registration_date, p: x.period, qty: x.quantity })));

    const depo = await pool.query(
        "SELECT registration_date, period::text, quantity FROM trades WHERE source='DEPO' AND reg_number='1-01-14044-A' LIMIT 5"
    );
    console.log('=== DEPO ===');
    depo.rows.forEach(x => console.log(JSON.stringify({ rd: x.registration_date, rdType: typeof x.registration_date, p: x.period, qty: x.quantity })));

    await pool.end();
}

go().catch(e => { console.error(e.message); process.exit(1); });
