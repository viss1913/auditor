/**
 * Smoke: global PDF scenarios — save without project_id, list visible, match with force id.
 * Usage: node server/scripts/smoke_pdf_scenarios_global.js [baseUrl]
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const base = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const isHttps = base.startsWith('https');
const httpMod = isHttps ? https : require('http');

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function request(method, urlPath, { token, body } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlPath.startsWith('http') ? urlPath : `${base}${urlPath}`);
        const payload = body ? JSON.stringify(body) : null;
        const req = httpMod.request(
            {
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
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
        console.error('SKIP/FAIL login', login.status, login.json);
        process.exit(login.status === 404 ? 0 : 1);
    }
    const token = login.json.token;

    const name = `smoke-global-${Date.now()}`;
    const save = await request('POST', '/api/pdf-parse-scenarios/from-extract', {
        token,
        body: {
            name,
            doc_kind: 'unknown',
            description: 'Smoke global scenario',
            tags: ['smoke', 'logistics'],
            page_width_pt: 595.28,
            column_centers_norm: [0.1, 0.5, 0.9],
            headers: ['Маршрут', 'Отправитель', 'Получатель'],
            probe_header_sample: ['Маршрут', 'Отправитель', 'Получатель'],
            markers: ['маршрут', 'отправитель'],
            text_snippet: 'Маршрут Отправитель Получатель склад',
            x_tol_norm: 0.05,
        },
    });
    if (save.status !== 200 || !save.json.scenario?.id) {
        console.error('FAIL save', save.status, save.json);
        process.exit(1);
    }
    const id = save.json.scenario.id;
    assertGlobal(save.json.scenario.projectId, null, 'projectId must be null');

    const list = await request('GET', '/api/pdf-parse-scenarios', { token });
    const found = (list.json.scenarios || []).some((s) => s.id === id);
    if (!found) {
        console.error('FAIL scenario not in global list', id);
        process.exit(1);
    }
    console.log(`OK global save+list id=${id}`);

    const logisticsPdf = path.join(__dirname, '../../docs/test-pdf-upload/05_unknown_logistics_sklad.pdf');
    if (fs.existsSync(logisticsPdf)) {
        const buf = fs.readFileSync(logisticsPdf);
        const boundary = '----smoke' + Date.now();
        const parts = [
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="05_unknown_logistics_sklad.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
            buf,
            `\r\n--${boundary}\r\nContent-Disposition: form-data; name="force_scenario_id"\r\n\r\n${id}\r\n--${boundary}--\r\n`,
        ];
        const bodyBuf = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
        const matchRes = await new Promise((resolve, reject) => {
            const url = new URL(`${base}/api/pdf-parse-scenarios/match`);
            const req = httpMod.request(
                {
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname,
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': `multipart/form-data; boundary=${boundary}`,
                        'Content-Length': bodyBuf.length,
                    },
                },
                (res) => {
                    let data = '';
                    res.on('data', (c) => (data += c));
                    res.on('end', () => {
                        try {
                            resolve({ status: res.statusCode, json: JSON.parse(data) });
                        } catch {
                            resolve({ status: res.statusCode, json: { raw: data } });
                        }
                    });
                }
            );
            req.on('error', reject);
            req.write(bodyBuf);
            req.end();
        });
        const ps = matchRes.json?.parseScenario;
        if (matchRes.status !== 200 || ps?.scenarioId !== id) {
            console.error('FAIL force match', matchRes.status, matchRes.json);
            process.exit(1);
        }
        console.log('OK force_scenario_id match on logistics PDF');
    } else {
        console.log('SKIP logistics PDF fixture not found');
    }

    console.log('SMOKE PASS global pdf scenarios');
}

function assertGlobal(actual, expected, msg) {
    if (actual !== expected) {
        console.error('FAIL', msg, actual);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
