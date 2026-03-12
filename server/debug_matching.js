const { Pool } = require('pg');
const pool = new Pool({
    user: 'postgres',
    password: '1qazXSW@',
    database: 'auditor',
    host: 'localhost',
    port: 5432,
});

const norm = (s) => String(s || '').trim().toUpperCase().replace(/[\s\-]/g, '');
const fmtDate = (d) => {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{2}\.\d{2}\.\d{4}/.test(d)) return d.substring(0, 10);
    const dt = (d instanceof Date) ? d : new Date(d);
    if (isNaN(dt.getTime())) return '';
    const day = String(dt.getUTCDate()).padStart(2, '0');
    const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const year = dt.getUTCFullYear();
    return `${day}.${month}.${year}`;
};
const qtyEqual = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.0001;

async function debug() {
    // Можно править эти параметры под конкретную бумагу/диапазон дат
    const targetReg = '1-01-16784-A';
    const likeName = '%Т-Техно%';

    const ukRes = await pool.query(
        "SELECT * FROM trades WHERE source = 'UK' AND (reg_number = $1 OR security_name ILIKE $2) ORDER BY period, id",
        [targetReg, likeName]
    );
    const brokerRes = await pool.query(
        "SELECT * FROM trades WHERE source = 'Broker' AND (reg_number = $1 OR security_name ILIKE $2) ORDER BY period, id",
        [targetReg, likeName]
    );
    const depoRes = await pool.query(
        "SELECT * FROM trades WHERE source = 'DEPO' AND (reg_number = $1 OR security_name ILIKE $2) ORDER BY period, id",
        [targetReg, likeName]
    );

    console.log('=== RAW UK ===');
    ukRes.rows.forEach(r => {
        console.log(
            `UK id=${r.id} | period=${fmtDate(r.period)} | reg_date=${fmtDate(r.registration_date)} | op=${r.operation_type} | reg=${r.reg_number} | isin=${r.isin} | qty=${r.quantity} | amt=${r.amount}`
        );
    });

    console.log('\n=== RAW BROKER ===');
    brokerRes.rows.forEach(r => {
        console.log(
            `BR id=${r.id} | period=${fmtDate(r.period)} | reg_date=${fmtDate(r.registration_date)} | op=${r.operation_type} | reg=${r.reg_number} | isin=${r.isin} | qty=${r.quantity} | amt=${r.amount}`
        );
    });

    console.log('\n=== RAW DEPO ===');
    depoRes.rows.forEach(r => {
        console.log(
            `DP id=${r.id} | period=${fmtDate(r.period)} | reg_date=${fmtDate(r.registration_date)} | op=${r.operation_type} | reg=${r.reg_number} | isin=${r.isin} | qty=${r.quantity}`
        );
    });

    const regToIsin = new Map();
    const isinToReg = new Map();
    [...brokerRes.rows, ...depoRes.rows, ...ukRes.rows].forEach(r => {
        const rn = norm(r.reg_number);
        const isin = norm(r.isin);
        if (rn && isin) {
            regToIsin.set(rn, isin);
            isinToReg.set(isin, rn);
        }
    });

    const getIsin = (rn, isin) => isin ? norm(isin) : (rn ? regToIsin.get(norm(rn)) : '');
    const getRegNum = (rn, isin) => rn ? norm(rn) : (isin ? isinToReg.get(norm(isin)) : '');

    const isPurchase = (type) => {
        const t = String(type || '').toLowerCase();
        return t.includes('покупка') || t.includes('зачисление');
    };
    const isSale = (type) => {
        const t = String(type || '').toLowerCase();
        return t.includes('продажа') || t.includes('списание');
    };

    console.log(`\nMaps: regToIsin size=${regToIsin.size}, isinToReg size=${isinToReg.size}`);

    const ukQtyMap = new Map();
    for (const uk of ukRes.rows) {
        const regDate = fmtDate(uk.registration_date);
        const rn = getRegNum(uk.reg_number, uk.isin);
        const isin = getIsin(uk.reg_number, uk.isin);
        const type = isPurchase(uk.operation_type) ? 'buy' : (isSale(uk.operation_type) ? 'sell' : 'other');
        const qty = parseFloat(uk.quantity) || 0;
        const key = rn ? `${regDate}|${rn}|${type}` : (isin ? `${regDate}|${isin}|${type}` : null);
        if (key) ukQtyMap.set(key, (ukQtyMap.get(key) || 0) + qty);
    }

    const depoQtyMap = new Map();
    for (const d of depoRes.rows) {
        const regDate = fmtDate(d.registration_date || d.period);
        const rn = getRegNum(d.reg_number, d.isin);
        const isin = getIsin(d.reg_number, d.isin);
        const type = isPurchase(d.operation_type) ? 'buy' : (isSale(d.operation_type) ? 'sell' : 'other');
        const qty = parseFloat(d.quantity) || 0;
        const key = rn ? `${regDate}|${rn}|${type}` : (isin ? `${regDate}|${isin}|${type}` : null);
        if (key) depoQtyMap.set(key, (depoQtyMap.get(key) || 0) + qty);
        console.log(`DEPO Entry: key=${key}, qty=${qty}, rawRN=${d.reg_number}, type=${type}`);
    }

    console.log('\nUK Qty Map Keys:', Array.from(ukQtyMap.keys()));
    console.log('DEPO Qty Map Keys:', Array.from(depoQtyMap.keys()));

    for (const [key, qty] of ukQtyMap.entries()) {
        const dQty = depoQtyMap.get(key) || 0;
        console.log(`Matching Key: ${key} -> UK Sum: ${qty}, DEPO Sum: ${dQty}, Equal: ${qtyEqual(qty, dQty)}`);
    }

    process.exit(0);
}

debug();
