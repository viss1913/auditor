const crypto = require('crypto');

const DEFAULT_TTL_SEC = parseInt(process.env.JWT_TTL_SEC || String(7 * 24 * 3600), 10) || 7 * 24 * 3600;

function base64url(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function jwtSecret() {
    const s = String(process.env.JWT_SECRET || '').trim();
    if (s) return s;
    if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET обязателен в production (Immerse / ПСИ)');
    }
    return 'auditor-dev-jwt-secret-change-me';
}

function signJwt(payload, ttlSec = DEFAULT_TTL_SEC) {
    const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = base64url(
        JSON.stringify({
            ...payload,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + ttlSec,
        })
    );
    const sig = crypto.createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest();
    return `${header}.${body}.${base64url(sig)}`;
}

function verifyJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = crypto.createHmac('sha256', jwtSecret()).update(`${header}.${body}`).digest();
    const actual = Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    let payload;
    try {
        const json = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        payload = JSON.parse(json);
    } catch {
        return null;
    }
    if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
}

module.exports = { signJwt, verifyJwt, jwtSecret, DEFAULT_TTL_SEC };
