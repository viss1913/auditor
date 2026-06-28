/**
 * Smoke: PDF parse scenarios API (login → list → save → list).
 * Usage: node server/scripts/smoke_pdf_scenarios_immers.js [baseUrl]
 */
const https = require('https');

const base = (process.argv[2] || 'https://195.209.210.166').replace(/\/$/, '');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function request(method, path, { token, body } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path.startsWith('http') ? path : `${base}${path}`);
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request(
            {
                hostname: url.hostname,
                port: url.port || 443,
                path: url.pathname + url.search,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
                },
            },
            (res) => {
                let data = '';
                res.on('data', (c) => (data += c));
                res.on('end', () => {
                    let json = {};
                    try {
                        json = data ? JSON.parse(data) : {};
                    } catch {
                        json = { raw: data };
                    }
                    resolve({ status: res.statusCode, json });
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function main() {
    const login = await request('POST', '/api/auth/login', {
        body: { email: 'admin@corp.local', password: 'Auditor2026!' },
    });
    if (login.status !== 200 || !login.json.token) {
        console.error('FAIL login', login.status, login.json);
        process.exit(1);
    }
    const token = login.json.token;
    console.log('OK login');

    const before = await request('GET', '/api/pdf-parse-scenarios', { token });
    if (before.status !== 200) {
        console.error('FAIL list', before.status, before.json);
        process.exit(1);
    }
    const countBefore = before.json.scenarios?.length ?? 0;
    console.log(`OK list (${countBefore} scenarios)`);

    const save = await request('POST', '/api/pdf-parse-scenarios/from-extract', {
        token,
        body: {
            name: `smoke-${Date.now()}`,
            doc_kind: 'unknown',
            page_width_pt: 595.28,
            column_centers_norm: [0.1, 0.5, 0.9],
            headers: ['a', 'b', 'c'],
            markers: ['smoke-test-marker', 'smoke-test-second'],
            x_tol_norm: 0.05,
        },
    });
    if (save.status !== 200 || !save.json.scenario?.id) {
        console.error('FAIL save', save.status, save.json);
        process.exit(1);
    }
    console.log(`OK save id=${save.json.scenario.id}`);

    const after = await request('GET', '/api/pdf-parse-scenarios', { token });
    const countAfter = after.json.scenarios?.length ?? 0;
    if (countAfter <= countBefore) {
        console.error('FAIL count did not grow', countBefore, '->', countAfter);
        process.exit(1);
    }
    console.log(`OK list after save (${countAfter} scenarios)`);
    console.log('SMOKE PASS');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
