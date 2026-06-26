/**
 * Демо-авторизация: один пароль из .env, без сессий в БД.
 * AUTH_STUB_ENABLED=0 — отключить (для локальной разработки).
 */

function isAuthStubEnabled() {
    return String(process.env.AUTH_STUB_ENABLED || '1') !== '0';
}

function expectedToken() {
    return String(process.env.DEMO_AUTH_TOKEN || 'auditor-demo').trim();
}

function expectedPassword() {
    return String(process.env.DEMO_AUTH_PASSWORD || 'demo').trim();
}

function expectedEmail() {
    return String(process.env.DEMO_AUTH_EMAIL || 'demo@bankfuture.ru').trim().toLowerCase();
}

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function tokenFromRequest(req) {
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return String(req.headers['x-demo-token'] || '').trim();
}

function isPublicPath(req) {
    const p = String(req.originalUrl || req.url || '').split('?')[0];
    if (p === '/ping') return true;
    if (p === '/api/auth/login') return true;
    return false;
}

function authStubMiddleware(req, res, next) {
    if (!isAuthStubEnabled() || isPublicPath(req)) return next();
    const token = tokenFromRequest(req);
    if (token && token === expectedToken()) return next();
    return res.status(401).json({ error: 'Требуется вход', code: 'AUTH_REQUIRED' });
}

function registerAuthStubRoutes(app) {
    app.post('/api/auth/login', (req, res) => {
        if (!isAuthStubEnabled()) {
            return res.json({ ok: true, token: expectedToken(), stub: true, disabled: true });
        }
        const email = normalizeEmail(req.body?.email);
        const password = String(req.body?.password || '');
        if (email !== expectedEmail()) {
            return res.status(401).json({ error: 'Неверный email' });
        }
        if (password !== expectedPassword()) {
            return res.status(401).json({ error: 'Неверный пароль' });
        }
        return res.json({ ok: true, token: expectedToken(), email, stub: true });
    });

    app.get('/api/auth/me', (req, res) => {
        if (!isAuthStubEnabled()) {
            return res.json({ ok: true, authenticated: true, stub: true, disabled: true });
        }
        const token = tokenFromRequest(req);
        if (token === expectedToken()) {
            return res.json({ ok: true, authenticated: true, email: expectedEmail(), stub: true });
        }
        return res.status(401).json({ ok: false, authenticated: false });
    });
}

module.exports = {
    authStubMiddleware,
    registerAuthStubRoutes,
    isAuthStubEnabled,
};
