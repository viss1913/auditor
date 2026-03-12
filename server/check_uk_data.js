const { Pool } = require('pg');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const pool = new Pool({
    host: process.env.DB_HOST,
    port: 5432,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: String(process.env.DB_PASSWORD),
});

async function checkData() {
    try {
        console.log('=== Проверка данных в УК ===');

        // 1. Проверяем на наличие не-чисел в колонках (на всякий случай)
        const stats = await pool.query(`
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN amount IS NULL OR amount = 0 THEN 1 ELSE 0 END) as zero_amounts,
                SUM(CASE WHEN quantity IS NULL OR quantity = 0 THEN 1 ELSE 0 END) as zero_qty,
                AVG(amount) as avg_amount,
                MAX(amount) as max_amount
            FROM trades WHERE source = 'UK'
        `);

        const s = stats.rows[0];
        console.log(`Всего записей УК: ${s.total}`);
        console.log(`Записей с нулевой суммой: ${s.zero_amounts}`);
        console.log(`Записей с нулевым кол-вом: ${s.zero_qty}`);
        console.log(`Средний чек: ${parseFloat(s.avg_amount).toFixed(2)}`);
        console.log(`Макс. сумма сделки: ${parseFloat(s.max_amount).toFixed(2)}`);

        // 2. Ищем дубликаты (полное совпадение всех полей)
        const dupes = await pool.query(`
            SELECT security_name, quantity, amount, period, registration_date, COUNT(*) as cnt 
            FROM trades 
            WHERE source='UK' 
            GROUP BY security_name, quantity, amount, period, registration_date 
            HAVING COUNT(*) > 1 
            ORDER BY cnt DESC 
            LIMIT 5
        `);

        if (dupes.rows.length > 0) {
            console.log('\n⚠️ Найдены подозрительные дубликаты (топ 5):');
            dupes.rows.forEach(d => {
                console.log(`  ${d.cnt} шт: ${d.security_name} | Кол: ${d.quantity} | Сумма: ${d.amount} | Дата: ${d.period}`);
            });
        } else {
            console.log('\n✅ Явных дубликатов не найдено.');
        }

        await pool.end();
    } catch (e) {
        console.error('Ошибка:', e.message);
    }
}

checkData();
