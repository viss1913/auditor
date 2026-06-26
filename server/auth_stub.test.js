const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { authStubMiddleware, registerAuthStubRoutes } = require('./auth_stub');

describe('auth_stub', () => {
    it('login: email + пароль → token', async () => {
        process.env.AUTH_STUB_ENABLED = '1';
        process.env.DEMO_AUTH_EMAIL = 'demo@test.ru';
        process.env.DEMO_AUTH_PASSWORD = 'demo';
        process.env.DEMO_AUTH_TOKEN = 'test-token';
        const app = express();
        app.use(express.json());
        registerAuthStubRoutes(app);
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'demo@test.ru', password: 'demo' }),
            });
            const data = await res.json();
            assert.equal(res.status, 200);
            assert.equal(data.token, 'test-token');
            assert.equal(data.email, 'demo@test.ru');
        } finally {
            server.close();
        }
    });

    it('login: неверный email → 401', async () => {
        process.env.AUTH_STUB_ENABLED = '1';
        process.env.DEMO_AUTH_EMAIL = 'demo@test.ru';
        process.env.DEMO_AUTH_PASSWORD = 'demo';
        const app = express();
        app.use(express.json());
        registerAuthStubRoutes(app);
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: 'wrong@test.ru', password: 'demo' }),
            });
            assert.equal(res.status, 401);
        } finally {
            server.close();
        }
    });

    it('middleware: без токена → 401', async () => {
        process.env.AUTH_STUB_ENABLED = '1';
        process.env.DEMO_AUTH_TOKEN = 'test-token';
        const app = express();
        app.use(express.json());
        registerAuthStubRoutes(app);
        app.use(authStubMiddleware);
        app.get('/api/secret', (req, res) => res.json({ ok: true }));
        const server = app.listen(0);
        const port = server.address().port;
        try {
            const res = await fetch(`http://127.0.0.1:${port}/api/secret`);
            assert.equal(res.status, 401);
        } finally {
            server.close();
        }
    });
});
