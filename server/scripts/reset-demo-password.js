require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
const { hashPassword } = require('../auth_password');
const { getPool } = require('../db_pool');

const pass = process.env.DEMO_AUTH_PASSWORD || 'Auditor2026!';
const email = process.env.DEMO_AUTH_EMAIL || 'admin@corp.local';

getPool()
    .query('UPDATE users SET password_hash = $1 WHERE LOWER(email) = LOWER($2)', [
        hashPassword(pass),
        email,
    ])
    .then((r) => {
        console.log('reset ok:', email, 'rows=', r.rowCount);
        process.exit(0);
    })
    .catch((e) => {
        console.error(e);
        process.exit(1);
    });
