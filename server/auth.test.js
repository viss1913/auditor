const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('./auth_password');
const { signJwt, verifyJwt } = require('./auth_jwt');

describe('auth_password', () => {
    it('hash + verify', () => {
        const hash = hashPassword('demo');
        assert.ok(hash.startsWith('scrypt$'));
        assert.equal(verifyPassword('demo', hash), true);
        assert.equal(verifyPassword('wrong', hash), false);
    });
});

describe('auth_jwt', () => {
    it('sign + verify roundtrip', () => {
        process.env.JWT_SECRET = 'test-secret';
        const token = signJwt({ userId: 42, role: 'auditor', email: 'a@b.ru' }, 3600);
        const payload = verifyJwt(token);
        assert.equal(payload.userId, 42);
        assert.equal(payload.role, 'auditor');
        assert.equal(payload.email, 'a@b.ru');
    });
});
