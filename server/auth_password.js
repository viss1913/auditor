const crypto = require('crypto');

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_PREFIX = 'scrypt';

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT_PARAMS);
    return `${HASH_PREFIX}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
    const raw = String(stored || '');
    if (!raw.startsWith(`${HASH_PREFIX}$`)) return false;
    const parts = raw.split('$');
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT_PARAMS);
    return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
