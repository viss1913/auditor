/**
 * Авторизация: users в PostgreSQL + JWT.
 * AUTH_STUB_ENABLED=1 — допускает старый DEMO_AUTH_TOKEN (мапится на demo-пользователя).
 * На Immerse: AUTH_STUB_ENABLED=0, JWT_SECRET=..., DATABASE_URL=...
 */
const { verifyPassword } = require('./auth_password');
const { signJwt, verifyJwt } = require('./auth_jwt');
const { getUserById, getUserByEmail } = require('./user_schema');
const { logActivity } = require('./activity_log');

function isAuthStubEnabled() {
    return String(process.env.AUTH_STUB_ENABLED || '1') !== '0';
}

function expectedToken() {
    return String(process.env.DEMO_AUTH_TOKEN || 'auditor-demo').trim();
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

function userResponse(user, token) {
    return {
        ok: true,
        token,
        email: user.email,
        userId: user.id,
        role: user.role,
        fullName: user.fullName,
    };
}

function createAuthMiddleware(pool) {
    let stubUserCache = null;

    async function resolveStubUser() {
        if (stubUserCache) return stubUserCache;
        const email = normalizeEmail(process.env.DEMO_AUTH_EMAIL || 'demo@bankfuture.ru');
        stubUserCache = await getUserByEmail(pool, email);
        return stubUserCache;
    }

    return async function authMiddleware(req, res, next) {
        if (isPublicPath(req)) return next();

        const token = tokenFromRequest(req);
        if (!token) {
            return res.status(401).json({ error: 'Требуется вход', code: 'AUTH_REQUIRED' });
        }

        const payload = verifyJwt(token);
        if (payload?.userId) {
            const user = await getUserById(pool, payload.userId);
            if (!user?.isActive) {
                return res.status(401).json({ error: 'Сессия недействительна', code: 'AUTH_REQUIRED' });
            }
            req.user = user;
            req.auth = { mode: 'jwt', userId: user.id, role: user.role };
            return next();
        }

        if (isAuthStubEnabled() && token === expectedToken()) {
            const stubUser = await resolveStubUser();
            if (stubUser?.isActive) {
                req.user = stubUser;
                req.auth = { mode: 'stub', userId: stubUser.id, role: stubUser.role };
                return next();
            }
        }

        return res.status(401).json({ error: 'Требуется вход', code: 'AUTH_REQUIRED' });
    };
}

function registerAuthRoutes(app, pool) {
    app.post('/api/auth/login', async (req, res) => {
        try {
            const email = normalizeEmail(req.body?.email);
            const password = String(req.body?.password || '');

            const user = await getUserByEmail(pool, email);
            if (user && verifyPassword(password, user.passwordHash)) {
                if (!user.isActive) {
                    return res.status(403).json({ error: 'Учётная запись отключена' });
                }
                await pool.query(`UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = $1`, [user.id]);
                await logActivity(pool, { userId: user.id, action: 'login' });
                const token = signJwt({ userId: user.id, role: user.role, email: user.email });
                return res.json(userResponse(user, token));
            }

            if (isAuthStubEnabled()) {
                const demoEmail = normalizeEmail(process.env.DEMO_AUTH_EMAIL || 'demo@bankfuture.ru');
                const demoPass = String(process.env.DEMO_AUTH_PASSWORD || 'demo');
                if (email === demoEmail && password === demoPass) {
                    const demoUser = await getUserByEmail(pool, demoEmail);
                    if (demoUser?.isActive) {
                        const token = signJwt({
                            userId: demoUser.id,
                            role: demoUser.role,
                            email: demoUser.email,
                        });
                        return res.json(userResponse(demoUser, token));
                    }
                    return res.json({
                        ok: true,
                        token: expectedToken(),
                        email: demoEmail,
                        stub: true,
                    });
                }
            }

            return res.status(401).json({ error: 'Неверный email или пароль' });
        } catch (err) {
            console.error('[auth/login]', err.message);
            res.status(500).json({ error: 'Ошибка входа' });
        }
    });

    app.get('/api/auth/me', async (req, res) => {
        try {
            const token = tokenFromRequest(req);
            if (!token) return res.status(401).json({ ok: false, authenticated: false });

            const payload = verifyJwt(token);
            if (payload?.userId) {
                const user = await getUserById(pool, payload.userId);
                if (!user?.isActive) return res.status(401).json({ ok: false, authenticated: false });
                return res.json({
                    ok: true,
                    authenticated: true,
                    email: user.email,
                    userId: user.id,
                    role: user.role,
                    fullName: user.fullName,
                });
            }

            if (isAuthStubEnabled() && token === expectedToken()) {
                const demoUser = await getUserByEmail(
                    pool,
                    process.env.DEMO_AUTH_EMAIL || 'demo@bankfuture.ru'
                );
                return res.json({
                    ok: true,
                    authenticated: true,
                    email: demoUser?.email || process.env.DEMO_AUTH_EMAIL,
                    userId: demoUser?.id || null,
                    role: demoUser?.role || 'auditor',
                    stub: true,
                });
            }

            return res.status(401).json({ ok: false, authenticated: false });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

function requireRole(...roles) {
    const allowed = new Set(roles);
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'Требуется вход' });
        if (!allowed.has(req.user.role)) {
            return res.status(403).json({ error: 'Недостаточно прав' });
        }
        next();
    };
}

module.exports = {
    createAuthMiddleware,
    registerAuthRoutes,
    requireRole,
    isAuthStubEnabled,
    tokenFromRequest,
    isPublicPath,
};
