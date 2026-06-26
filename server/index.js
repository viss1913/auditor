const express = require('express');
const multer = require('multer');
const cors = require('cors');
const xlsx = require('xlsx');
const path = require('path');
const dotenv = require('dotenv');

// Пробуем оба пути — из server/ и из корня
const path1 = path.resolve(__dirname, '../.env');
const path2 = path.resolve(__dirname, '.env');
dotenv.config({ path: path1 });
if (!process.env.DB_HOST) dotenv.config({ path: path2 });
console.log('[ENV PATH]', path1, '| DB_HOST:', process.env.DB_HOST);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use((req, res, next) => {
    if (String(req.url || '').includes('/inbox')) {
        console.log(
            `[http] ${req.method} ${req.url} origin=${req.headers.origin || '-'} len=${req.headers['content-length'] || '?'}`
        );
    }
    next();
});
app.use(express.json({ limit: '20mb' }));

// Подключаем новый роутер изолированно
const aiParserApi = require('./ai_parser_api');
const kseniyaApi = require('./kseniya_api');
const { parseUK } = require('./parse_uk');
const { validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const { runParseEngine } = require('./parse_engine');
const { V2_ONLY_MSG } = require('./parse_preview');
const { parseBroker } = require('./parse_broker');
const { parseDepo } = require('./parse_depo');
const { getPool } = require('./db_pool');
const { createAuthMiddleware, registerAuthRoutes } = require('./auth');
const { ensureUsersSchema } = require('./user_schema');

const pool = getPool();

registerAuthRoutes(app, pool);
app.use(createAuthMiddleware(pool));

app.use('/api', aiParserApi);
app.use('/api', kseniyaApi);

const upload = multer({ dest: 'uploads/' });

function tradeOwnerId(req) {
    return req.user?.id ?? null;
}

// Проверка подключения и создание таблиц
const initDb = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trades (
                id SERIAL PRIMARY KEY,
                period DATE,
                operation_type TEXT DEFAULT '',
                security_name TEXT,
                reg_number TEXT,
                isin TEXT,
                quantity NUMERIC(20, 4),
                amount NUMERIC(20, 2),
                currency TEXT DEFAULT '',
                registration_date TEXT DEFAULT '',
                fee NUMERIC(20, 2) DEFAULT 0,
                debit_account TEXT,
                credit_account TEXT,
                source TEXT DEFAULT 'UK',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_trades_period ON trades(period);
            CREATE INDEX IF NOT EXISTS idx_trades_reg_number ON trades(reg_number);
        `);
        // Добавляем новые столбцы, если их нет (для апгрейда старых таблиц)
        const alterQueries = [
            `ALTER TABLE trades ADD COLUMN IF NOT EXISTS operation_type TEXT DEFAULT '';`,
            `ALTER TABLE trades ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT '';`,
            `ALTER TABLE trades ADD COLUMN IF NOT EXISTS registration_date TEXT DEFAULT '';`,
            `ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee NUMERIC(20, 2) DEFAULT 0;`
        ];
        for (let q of alterQueries) await pool.query(q);

        const { PARSE_SNAPSHOT_DDL } = require('./parse_snapshot_schema');
        await pool.query(PARSE_SNAPSHOT_DDL);
        await pool.query(
            `ALTER TABLE parse_snapshots ADD COLUMN IF NOT EXISTS table_meta JSONB NOT NULL DEFAULT '{}'::jsonb;`
        );
        const { ensureAuditorsSchema } = require('./auditor_schema');
        await ensureAuditorsSchema(pool);
        await ensureUsersSchema(pool);

        console.log('✅ База данных готова (таблицы проверены)');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err.message);
    }
};

initDb();

app.get('/ping', (req, res) => res.send('Асоль на связи!'));

app.post('/upload', upload.array('files'), async (req, res) => {
    const type = String(req.body.type || 'uk').toLowerCase();
    const mode = req.body.mode || 'overwrite';

    // ОСВ: только превью плоской таблицы, без записи в trades (MVP)
    if (type === 'osv') {
        if (!req.files?.length) {
            return res.status(400).json({ error: 'Нужен файл Excel' });
        }
        let ruleJson = null;
        if (req.body.ruleJson && String(req.body.ruleJson).trim() !== '') {
            let parsed;
            try {
                parsed = JSON.parse(req.body.ruleJson);
            } catch (e) {
                return res.status(400).json({ error: 'ruleJson: некорректный JSON' });
            }
            const validated = validateParsingRuleV2(parsed);
            if (!validated.ok) {
                return res.status(400).json({ error: validated.errors.join('; ') });
            }
            if (Number(validated.rule.rule_schema_version) !== 2) {
                return res.status(400).json({ error: V2_ONLY_MSG });
            }
            ruleJson = validated.rule;
        } else {
            return res.status(400).json({ error: 'Для ОСВ нужен ruleJson (ParsingRule v2)' });
        }
        try {
            const file = req.files[0];
            const { rows, headers, rowCount } = (() => {
                const r = runParseEngine(file.path, ruleJson);
                if (!r.ok) throw new Error(r.errors.join('; '));
                return {
                    headers: r.headers,
                    rows: r.rows.slice(0, 100),
                    rowCount: r.rowCount,
                };
            })();
            return res.json({
                previewOnly: true,
                type: 'osv',
                rule: ruleJson,
                headers,
                rows,
                rowCount,
            });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    let sourceName = 'UK';
    if (type === 'broker') sourceName = 'Broker';
    else if (type === 'depo') sourceName = 'DEPO';

    const ownerId = tradeOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'Требуется вход' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (mode === 'overwrite') {
            await client.query('DELETE FROM trades WHERE source = $1 AND owner_user_id = $2', [
                sourceName,
                ownerId,
            ]);
        }

        let ruleJson = null;
        if (req.body.ruleJson && String(req.body.ruleJson).trim() !== '') {
            let parsed;
            try {
                parsed = JSON.parse(req.body.ruleJson);
            } catch (e) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'ruleJson: некорректный JSON' });
            }
            const validated = validateParsingRuleV2(parsed);
            if (!validated.ok) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: validated.errors.join('; ') });
            }
            if (Number(validated.rule.rule_schema_version) !== 2) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: V2_ONLY_MSG });
            }
            ruleJson = validated.rule;
        }

        for (const file of req.files) {
            try { file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch (e) { }
            console.log('[UPLOAD] file.originalname =', file.originalname);
            let results = [];
            if (ruleJson && type === 'uk') {
                const out = runParseEngine(file.path, ruleJson);
                if (!out.ok) throw new Error(out.errors.join('; '));
                results = out.rows.map((r) => ({
                    period: r.period,
                    operationType: r.operationType || ruleJson.output?.operation_type || '',
                    name: r.name,
                    regNum: r.regNum || '',
                    isin: r.isin || '',
                    amount: r.amount ?? 0,
                    quantity: r.quantity ?? 0,
                    currency: 'RUB',
                    registrationDate: r.period,
                    fee: 0,
                    debit_account: r.debit_account || '',
                    credit_account: r.credit_account || '',
                }));
            } else if (type === 'uk') {
                results = parseUK(file.path);
            } else if (type === 'broker') {
                results = parseBroker(file.path);
            } else if (type === 'depo') {
                results = await parseDepo(file.path, file.originalname);
            }

            const chunkSize = 500;
            for (let i = 0; i < results.length; i += chunkSize) {
                const chunk = results.slice(i, i + chunkSize);
                const values = [];
                const placeholders = chunk.map((c, idx) => {
                    const o = idx * 13;
                    values.push(
                        c.period, c.operationType || '', c.name, c.regNum, c.isin,
                        c.quantity, c.amount, c.currency, c.registrationDate, c.fee,
                        c.debit_account, c.credit_account, ownerId
                    );
                    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}, $${o + 11}, $${o + 12}, '${sourceName}', $${o + 13})`;
                }).join(',');

                await client.query(`INSERT INTO trades 
                    (period, operation_type, security_name, reg_number, isin, quantity, amount, currency, registration_date, fee, debit_account, credit_account, source, owner_user_id) 
                    VALUES ${placeholders}`, values);
            }
        }
        await client.query('COMMIT');

        const finalResult = await client.query(
            'SELECT * FROM trades WHERE source = $1 AND owner_user_id = $2 ORDER BY id ASC',
            [sourceName, ownerId]
        );
        res.json(finalResult.rows.map(r => ({
            period: r.period ? new Date(r.period).toLocaleDateString('ru-RU') : '',
            operationType: r.operation_type || '',
            name: r.security_name,
            regNum: r.reg_number || '',
            isin: r.isin || '',
            quantity: r.quantity,
            amount: r.amount,
            currency: r.currency || '',
            registrationDate: r.registration_date || '',
            fee: parseFloat(r.fee) || 0,
            debit_account: r.debit_account || '',
            source: r.source
        })));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[DATABASE ERROR]', error.message);
        res.status(500).json({ error: 'Ошибка БД: ' + error.message });
    } finally {
        client.release();
    }
});

app.delete('/trades', async (req, res) => {
    const { source } = req.query;
    if (!source) return res.status(400).json({ error: 'Укажи источник' });
    const ownerId = tradeOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'Требуется вход' });

    const s = source.toLowerCase();
    const sourceName = (s === 'uk') ? 'UK' : (s === 'broker' ? 'Broker' : 'DEPO');

    try {
        await pool.query('DELETE FROM trades WHERE source = $1 AND owner_user_id = $2', [sourceName, ownerId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/trades', async (req, res) => {
    let { source } = req.query;
    const ownerId = tradeOwnerId(req);
    if (!ownerId) return res.status(401).json({ error: 'Требуется вход' });
    if (source) {
        const s = source.toLowerCase();
        source = (s === 'uk') ? 'UK' : (s === 'broker' ? 'Broker' : 'DEPO');
    }
    try {
        const query = source
            ? {
                  text: 'SELECT * FROM trades WHERE source = $1 AND owner_user_id = $2 ORDER BY id ASC',
                  values: [source, ownerId],
              }
            : {
                  text: 'SELECT * FROM trades WHERE owner_user_id = $1 ORDER BY id ASC',
                  values: [ownerId],
              };

        const result = await pool.query(query);
        const formatted = result.rows.map(r => ({
            period: r.period ? new Date(r.period).toLocaleDateString('ru-RU') : '',
            operationType: r.operation_type || '',
            name: r.security_name,
            regNum: r.reg_number || '',
            isin: r.isin || '',
            quantity: r.quantity,
            amount: r.amount,
            currency: r.currency || '',
            registrationDate: r.registration_date || '',
            fee: parseFloat(r.fee) || 0,
            debit_account: r.debit_account || '',
            source: r.source
        }));
        res.json(formatted);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка при получении данных' });
    }
});

// =============== ПОДГОТОВКА К АУДИТУ (что в базах, какие ключи строятся) ===============
/** @deprecated Legacy OPIF audit on `trades`. Use Martin universal reconcile (`/api/reconcile/*`). */
app.get('/audit/preview', async (req, res) => {
    try {
        const ownerId = tradeOwnerId(req);
        if (!ownerId) return res.status(401).json({ error: 'Требуется вход' });
        const [ukRes, brokerRes, depoRes] = await Promise.all([
            pool.query(
                "SELECT id, period, registration_date, operation_type, security_name, reg_number, isin, quantity, amount FROM trades WHERE source = 'UK' AND owner_user_id = $1 ORDER BY period, id",
                [ownerId]
            ),
            pool.query(
                "SELECT id, period, registration_date, operation_type, security_name, reg_number, isin, quantity FROM trades WHERE source = 'Broker' AND owner_user_id = $1",
                [ownerId]
            ),
            pool.query(
                "SELECT id, period, registration_date, operation_type, security_name, reg_number, isin, quantity FROM trades WHERE source = 'DEPO' AND owner_user_id = $1 ORDER BY period, id",
                [ownerId]
            ),
        ]);

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
        const isPurchase = (type) => { const t = String(type || '').toLowerCase(); return t.includes('покупка') || t.includes('зачисление'); };
        const isSale = (type) => { const t = String(type || '').toLowerCase(); return t.includes('продажа') || t.includes('списание'); };

        const brokerRows = brokerRes.rows;
        const depoRows = depoRes.rows;

        const regToIsin = new Map();
        const isinToReg = new Map();
        [...brokerRows, ...depoRows, ...ukRes.rows].forEach(r => {
            const rn = norm(r.reg_number);
            const isin = norm(r.isin);
            if (rn && isin) { regToIsin.set(rn, isin); isinToReg.set(isin, rn); }
        });

        const getIsin = (rn, isin) => isin ? norm(isin) : (rn ? regToIsin.get(norm(rn)) : '');
        const getRegNum = (rn, isin) => rn ? norm(rn) : (isin ? isinToReg.get(norm(isin)) : '');

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
        for (const d of depoRows) {
            const regDate = fmtDate(d.registration_date || d.period);
            const rn = getRegNum(d.reg_number, d.isin);
            const isin = getIsin(d.reg_number, d.isin);
            const type = isPurchase(d.operation_type) ? 'buy' : (isSale(d.operation_type) ? 'sell' : 'other');
            const qty = parseFloat(d.quantity) || 0;
            const key = rn ? `${regDate}|${rn}|${type}` : (isin ? `${regDate}|${isin}|${type}` : null);
            if (key) depoQtyMap.set(key, (depoQtyMap.get(key) || 0) + qty);
        }

        const ukKeys = Array.from(ukQtyMap.entries()).map(([key, qty]) => ({ key, qty }));
        const depoKeys = Array.from(depoQtyMap.entries()).map(([key, qty]) => ({ key, qty }));

        const onlyInUk = ukKeys.filter(({ key }) => !depoQtyMap.has(key));
        const onlyInDepo = depoKeys.filter(({ key }) => !ukQtyMap.has(key));
        const commonKeys = ukKeys.filter(({ key }) => depoQtyMap.has(key)).map(({ key, qty }) => ({
            key,
            ukQty: qty,
            depoQty: depoQtyMap.get(key),
            match: Math.abs(parseFloat(qty) - parseFloat(depoQtyMap.get(key))) < 0.0001
        }));

        const sample = (rows, n = 10) => rows.slice(0, n).map(r => ({
            period: r.period,
            registration_date: fmtDate(r.registration_date || r.period),
            operation_type: r.operation_type,
            reg_number: r.reg_number || '',
            isin: r.isin || '',
            quantity: r.quantity
        }));

        res.json({
            counts: { uk: ukRes.rows.length, broker: brokerRows.length, depo: depoRows.length },
            regToIsinSize: regToIsin.size,
            sampleRegToIsin: Array.from(regToIsin.entries()).slice(0, 10),
            sampleUk: sample(ukRes.rows),
            sampleDepo: sample(depoRows),
            ukKeys,
            depoKeys,
            onlyInUk,
            onlyInDepo,
            commonKeys,
            hint: 'Ключ = дата_рег|норм_рег_или_ISIN|buy|sell. Покупка(УК)=Зачисление(ДЕПО)=buy, Продажа=Списание=sell.'
        });
    } catch (e) {
        console.error('[AUDIT PREVIEW]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// =============== АУДИТ ===============
/** @deprecated Legacy OPIF three-way audit on `trades`. Use Martin universal reconcile (`/api/reconcile/*`). */
app.get('/audit', async (req, res) => {
    try {
        const ownerId = tradeOwnerId(req);
        if (!ownerId) return res.status(401).json({ error: 'Требуется вход' });
        const debug = req.query.debug === '1' || req.query.debug === 'true';

        const [ukRes, brokerRes, depoRes] = await Promise.all([
            pool.query(
                "SELECT * FROM trades WHERE source = 'UK' AND owner_user_id = $1 ORDER BY period ASC",
                [ownerId]
            ),
            pool.query("SELECT * FROM trades WHERE source = 'Broker' AND owner_user_id = $1", [ownerId]),
            pool.query("SELECT * FROM trades WHERE source = 'DEPO' AND owner_user_id = $1", [ownerId]),
        ]);

        const brokerRows = brokerRes.rows;
        const depoRows = depoRes.rows;

        if (debug) {
            console.log('[AUDIT DEBUG] === Исходные данные ===');
            console.log('[AUDIT DEBUG] УК записей:', ukRes.rows.length);
            console.log('[AUDIT DEBUG] Брокер записей:', brokerRows.length);
            console.log('[AUDIT DEBUG] ДЕПО записей:', depoRows.length);
        }

        // Нормализация строки для сравнения
        const norm = (s) => String(s || '').trim().toUpperCase().replace(/[\s\-]/g, '');
        const fmtDate = (d) => {
            if (!d) return '';
            // Уже строка dd.mm.yyyy — возвращаем как есть
            if (typeof d === 'string' && /^\d{2}\.\d{2}\.\d{4}/.test(d)) return d.substring(0, 10);
            // JS Date объект (pg возвращает DATE-колонку как Date)
            const dt = (d instanceof Date) ? d : new Date(d);
            if (isNaN(dt.getTime())) return '';
            const day = String(dt.getUTCDate()).padStart(2, '0');
            const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
            const year = dt.getUTCFullYear();
            return `${day}.${month}.${year}`;
        };
        const amtEqual = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 1.0;
        const qtyEqual = (a, b) => Math.abs(parseFloat(a) - parseFloat(b)) < 0.0001;

        // === 1. Обогащение бумаг (собираем карту соответствия RegNum <-> ISIN) ===
        const regToIsin = new Map();
        const isinToReg = new Map();
        [...brokerRows, ...depoRows, ...ukRes.rows].forEach(r => {
            const rn = norm(r.reg_number || r.regNum);
            const isin = norm(r.isin);
            if (rn && isin) {
                regToIsin.set(rn, isin);
                isinToReg.set(isin, rn);
            }
        });

        const getIsin = (rn, isin) => isin ? norm(isin) : (rn ? regToIsin.get(norm(rn)) : '');
        const getRegNum = (rn, isin) => rn ? norm(rn) : (isin ? isinToReg.get(norm(isin)) : '');

        // Покупка (УК) = Зачисление ЦБ (ДЕПО) → buy; Продажа (УК) = Списание ЦБ (ДЕПО) → sell
        const isPurchase = (type) => {
            const t = String(type || '').toLowerCase();
            return t.includes('покупка') || t.includes('зачисление');
        };
        const isSale = (type) => {
            const t = String(type || '').toLowerCase();
            return t.includes('продажа') || t.includes('списание');
        };

        if (debug) {
            console.log('[AUDIT DEBUG] === Карта reg↔ISIN (из строк, где есть оба) ===');
            console.log('[AUDIT DEBUG] regToIsin записей:', regToIsin.size);
            if (regToIsin.size > 0) {
                const sample = Array.from(regToIsin.entries()).slice(0, 5);
                sample.forEach(([r, i]) => console.log('[AUDIT DEBUG]   ', r, '→', i));
            }
        }

        // === 2. Предварительная группировка УК / ДЕПО для матчинга ===
        // Ключ: "regDate|normRegNum|type" или "regDate|normIsin|type"
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
        for (const depo of depoRows) {
            const regDate = fmtDate(depo.registration_date || depo.period);
            const rn = getRegNum(depo.reg_number, depo.isin);
            const isin = getIsin(depo.reg_number, depo.isin);
            const type = isPurchase(depo.operation_type) ? 'buy' : (isSale(depo.operation_type) ? 'sell' : 'other');
            const qty = parseFloat(depo.quantity) || 0;

            const key = rn ? `${regDate}|${rn}|${type}` : (isin ? `${regDate}|${isin}|${type}` : null);
            if (key) depoQtyMap.set(key, (depoQtyMap.get(key) || 0) + qty);
        }

        if (debug) {
            console.log('[AUDIT DEBUG] === Группы УК (ключ = дата|бумага_reg_или_ISIN|buy/sell) ===');
            for (const [k, v] of ukQtyMap.entries()) console.log('[AUDIT DEBUG]   УК  ', k, '→ кол-во', v);
            console.log('[AUDIT DEBUG] === Группы ДЕПО ===');
            for (const [k, v] of depoQtyMap.entries()) console.log('[AUDIT DEBUG]   ДЕПО', k, '→ кол-во', v);
        }

        const results = ukRes.rows.map((uk, idx) => {
            const ukRegDate = fmtDate(uk.registration_date);
            const ukRegNum = getRegNum(uk.reg_number, uk.isin);
            const ukIsin = getIsin(uk.reg_number, uk.isin);
            const ukQty = parseFloat(uk.quantity);
            const ukAmt = parseFloat(uk.amount);
            const ukOp = uk.operation_type;
            const ukType = isPurchase(ukOp) ? 'buy' : (isSale(ukOp) ? 'sell' : 'other');

            // Суммарное кол-во по этой группе (дата + бумага + тип)
            const groupKey = ukRegNum ? `${ukRegDate}|${ukRegNum}|${ukType}` : (ukIsin ? `${ukRegDate}|${ukIsin}|${ukType}` : null);
            const ukGroupQty = groupKey ? (ukQtyMap.get(groupKey) || ukQty) : ukQty;
            const depoGroupQty = groupKey ? (depoQtyMap.get(groupKey) || 0) : 0;

            // Матчинг с брокером ПОСТРОЧНО (по отдельным сделкам)
            const brokerMatch = brokerRows.find(b => {
                // Сверяем по дате регистрации: у брокера берем ТОЛЬКО registration_date, period используем как запасной вариант
                const bRegDate = fmtDate(b.registration_date || b.period);
                if (bRegDate !== ukRegDate) return false;

                const bType = isPurchase(b.operation_type) ? 'buy' : (isSale(b.operation_type) ? 'sell' : 'other');
                if (bType !== ukType) return false;

                const bRN = getRegNum(b.reg_number, b.isin);
                const bIsin = getIsin(b.reg_number, b.isin);

                const bothEmptyUK = !ukRegNum && !ukIsin;
                if (bothEmptyUK) {
                    const bothEmptyBroker = !bRN && !bIsin;
                    return bothEmptyBroker && amtEqual(b.amount, ukAmt);
                }

                const regMatch = ukRegNum && bRN === ukRegNum;
                const isinMatch = ukIsin && bIsin === ukIsin;
                if (!regMatch && !isinMatch) return false;

                if (ukQty === 0) return amtEqual(b.amount, ukAmt);
                return qtyEqual(b.quantity, ukQty) && amtEqual(b.amount, ukAmt);
            });
            const brokerFound = !!brokerMatch;

            // Матчинг с ДЕПО (теперь через агрегат)
            let depoFound = false;
            if (groupKey && depoQtyMap.has(groupKey)) {
                if (ukGroupQty === 0 || qtyEqual(depoGroupQty, ukGroupQty)) {
                    depoFound = true;
                }
            }

            if (debug && idx < 20) {
                console.log('[AUDIT DEBUG] --- Строка УК #' + (idx + 1) + ' ---');
                console.log('[AUDIT DEBUG]   операция (сырая):', JSON.stringify(uk.operation_type), '→ тип:', ukType, '(покупка/зачисление=buy, продажа/списание=sell)');
                console.log('[AUDIT DEBUG]   дата рег.:', ukRegDate, '| бумага reg:', ukRegNum || '(нет)', '| isin:', ukIsin || '(нет)');
                console.log('[AUDIT DEBUG]   ключ группы:', groupKey);
                console.log('[AUDIT DEBUG]   УК сумма по группе:', ukGroupQty, '| ДЕПО сумма по группе:', depoGroupQty, '| brokerOK:', brokerFound, '| depoOK:', depoFound);
            }

            const row = {
                registrationDate: ukRegDate,
                operationType: ukOp,
                name: uk.security_name || '',
                regNum: ukRegNum || uk.reg_number || '',
                isin: ukIsin || uk.isin || '',
                quantity: uk.quantity,
                ukGroupQty,
                amount: uk.amount,
                currency: uk.currency || '',
                brokerFound,
                depoFound,
                depoGroupQty
            };
            if (debug) {
                row._debug = {
                    groupKey,
                    ukGroupQty,
                    depoGroupQty,
                    typeResolved: ukType,
                    opRaw: uk.operation_type
                };
            }
            return row;
        });

        if (debug) console.log('[AUDIT DEBUG] === Конец логов аудита ===');

        res.json(results);
    } catch (error) {
        console.error('[AUDIT ERROR]', error.message);
        res.status(500).json({ error: error.message });
    }
});


const PORT = 3001;
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Сервер Асоль на порту ${PORT}`));
const PARSE_HTTP_TIMEOUT_MS = Number(process.env.MARTIN_PARSE_TIMEOUT_MS || 1_800_000);
server.requestTimeout = PARSE_HTTP_TIMEOUT_MS;
server.headersTimeout = PARSE_HTTP_TIMEOUT_MS + 60_000;
