const express = require('express');
const multer = require('multer');
const cors = require('cors');
const xlsx = require('xlsx');
const path = require('path');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const fs = require('fs');
const pdfParse = require('pdf-parse');

// Пробуем оба пути — из server/ и из корня
const path1 = path.resolve(__dirname, '../.env');
const path2 = path.resolve(__dirname, '.env');
dotenv.config({ path: path1 });
if (!process.env.DB_HOST) dotenv.config({ path: path2 });
console.log('[ENV PATH]', path1, '| DB_HOST:', process.env.DB_HOST);

const app = express();
app.use(cors());
app.use(express.json());

// Подключаем новый роутер изолированно
const aiParserApi = require('./ai_parser_api');
const { smartParseUK } = require('./smart_parse_uk');
const { parseUK } = require('./parse_uk');
const { parseAndValidateUkRuleJsonString } = require('./uk_rule_validate');
app.use('/api', aiParserApi);

const upload = multer({ dest: 'uploads/' });

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'auditor',
    user: process.env.DB_USER || 'postgres',
    password: String(process.env.DB_PASSWORD || '1qazXSW@'),
});

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

        console.log('✅ База данных готова (таблицы проверены)');
    } catch (err) {
        console.error('❌ Ошибка инициализации БД:', err.message);
    }
};

initDb();

app.get('/ping', (req, res) => res.send('Асоль на связи!'));

// Логика парсинга Брокера (Раздел 1.2) — ВЕРСИЯ 10 (С комиссиями, датой рег. и валютой)
function parseBroker(filePath) {
    const workbook = xlsx.readFile(filePath, { cellDates: true });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    const results = [];
    let inSection = false;

    console.log(`--- Парсинг Брокера (v10) --- Файл: ${filePath}`);

    data.forEach((row, index) => {
        if (!Array.isArray(row)) return;
        const rowText = row.map(v => String(v)).join(' ').toLowerCase();

        // Поиск начала раздела 1.2
        if (!inSection && rowText.includes('1.2.') && rowText.includes('сделки') && rowText.includes('не исполнены')) {
            inSection = true;
            return;
        }

        // Поиск конца раздела
        if (inSection && (rowText.includes('1.3.') || rowText.includes('раздел 2'))) {
            const startText = row.slice(0, 10).join(' ').toLowerCase();
            if (startText.includes('1.3.') || startText.includes('раздел 2') || startText.includes('2.')) {
                inSection = false;
            }
        }

        if (inSection) {
            let dateStr = '';
            let dateIdx = -1;

            // Ищем дату в первых 5 колонках
            for (let i = 0; i < Math.min(row.length, 5); i++) {
                const val = row[i];
                if (!val) continue;
                if (val instanceof Date) {
                    dateStr = val.toLocaleDateString('ru-RU');
                    dateIdx = i;
                    break;
                }
                const sval = String(val).trim();
                const m = sval.match(/^(\d{2}\.\d{2}\.\d{4})/);
                if (m) {
                    dateStr = m[1];
                    dateIdx = i;
                    break;
                }
            }

            if (dateStr && dateIdx !== -1) {
                // Ищем тип операции
                let operation = '';
                let opIdx = -1;
                for (let i = dateIdx + 1; i < Math.min(dateIdx + 6, row.length); i++) {
                    const val = String(row[i] || '').trim();
                    const valLow = val.toLowerCase();
                    if (valLow.includes('покупка') || valLow.includes('продажа') || valLow.includes('репо')) {
                        operation = val;
                        opIdx = i;
                        break;
                    }
                }

                if (operation && opIdx !== -1) {
                    let longCells = [];
                    for (let i = opIdx + 1; i < row.length; i++) {
                        const val = String(row[i] || '').trim();
                        if (val.length > 3) {
                            longCells.push({ val: val.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim(), idx: i });
                        }
                    }

                    let securityInfo = '';
                    let infoIdx = -1;

                    // Стратегия 1: ищем ячейку с явным ISIN
                    for (const cell of longCells) {
                        if (/ISIN/i.test(cell.val) || /[A-Z]{2}[A-Z0-9]{10}/.test(cell.val) || /\d[\dА-Яа-яA-Za-z]{0,3}-\d{2}-\d{4,6}/.test(cell.val)) {
                            securityInfo = cell.val;
                            infoIdx = cell.idx;
                            break;
                        }
                    }

                    // Стратегия 2: если ISIN не найден, берём 2-ю длинную ячейку
                    if (!securityInfo && longCells.length >= 2) {
                        securityInfo = longCells[1].val;
                        infoIdx = longCells[1].idx;
                    }
                    if (!securityInfo && longCells.length === 1) {
                        securityInfo = longCells[0].val;
                        infoIdx = longCells[0].idx;
                    }

                    if (securityInfo) {
                        const isinMatch = securityInfo.match(/ISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})/i) || securityInfo.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
                        const isin = isinMatch ? isinMatch[1] : '';

                        // Паттерн 1: "1-01-12345-A" (с дефисами)
                        const regMatch = securityInfo.match(/(\d[\dА-Яа-яA-Za-z]{0,3}-\d{2}-\d{4,6}-[А-ЯA-Z\d-]+)/i);
                        // Паттерн 2: "10100963B" — цифры + буква (без дефисов)
                        const regMatchShort = !regMatch ? securityInfo.match(/\b(\d{7,9}[A-Z])\b/) : null;
                        const regNum = regMatch ? regMatch[1] : (regMatchShort ? regMatchShort[1] : '');
                        const regMatchUsed = regMatch || regMatchShort;

                        let name = securityInfo;
                        if (isinMatch) name = name.split(isinMatch[0])[0];
                        if (regMatchUsed) name = name.replace(regMatchUsed[0], '');
                        name = name.replace(/ISIN/gi, '').replace(/[№\u2116]\s*/g, '').trim();
                        name = name.replace(/[\s,;|]+$/, '').trim();

                        // Извлекаем числа для Кол-ва и Суммы
                        let foundNums = [];
                        for (let i = infoIdx + 1; i < row.length; i++) {
                            const val = row[i];
                            if (typeof val === 'number' && val !== 0) foundNums.push(val);
                            else if (val) {
                                const n = parseFloat(String(val).replace(/\s/g, '').replace(',', '.'));
                                if (!isNaN(n) && n !== 0) foundNums.push(n);
                            }
                        }

                        const quantity = foundNums[0] || 0;
                        const amount = foundNums[3] || foundNums[foundNums.length - 1] || 0;

                        // Ищем Валюту, Даты регистрации/оплаты и Комиссии
                        let currency = '';
                        let currencyIdx = -1;
                        for (let i = infoIdx + 1; i < row.length; i++) {
                            if (['RUB', 'USD', 'EUR', 'CNY'].includes(String(row[i]).trim().toUpperCase())) {
                                currency = String(row[i]).trim().toUpperCase();
                                currencyIdx = i;
                                break;
                            }
                        }

                        let registrationDate = '';
                        let regDateIdx = -1;
                        if (currencyIdx !== -1) {
                            for (let i = currencyIdx + 1; i < row.length; i++) {
                                const val = row[i];
                                if (!val) continue;
                                if (val instanceof Date) {
                                    registrationDate = val.toLocaleDateString('ru-RU');
                                    // Пропускаем дату оплаты, которая идет следом
                                    for (let j = i + 1; j < row.length; j++) {
                                        if (row[j] instanceof Date || /^(\d{2}\.\d{2}\.\d{4})/.test(String(row[j]).trim())) {
                                            regDateIdx = j; // Индекс последней найденной даты (дата оплаты)
                                            break;
                                        }
                                    }
                                    if (regDateIdx === -1) regDateIdx = i;
                                    break;
                                }
                                const sval = String(val).trim();
                                const m = sval.match(/^(\d{2}\.\d{2}\.\d{4})/);
                                if (m) {
                                    registrationDate = m[1];
                                    // Ищем вторую дату
                                    for (let j = i + 1; j < row.length; j++) {
                                        if (row[j] instanceof Date || /^(\d{2}\.\d{2}\.\d{4})/.test(String(row[j]).trim())) {
                                            regDateIdx = j;
                                            break;
                                        }
                                    }
                                    if (regDateIdx === -1) regDateIdx = i;
                                    break;
                                }
                            }
                        }

                        // Ищем комиссии после дат (все числовые значения суммируем)
                        let fee = 0;
                        if (regDateIdx !== -1) {
                            let totalFee = 0;
                            let feeFound = false;

                            // Комиссии могут быть очень далеко (из-за пустых столбцов объединения)
                            // Идем прямо до конца строки, пока не встретим стоп-слова (Портфель/Субсчет)
                            for (let i = regDateIdx + 1; i < row.length; i++) {
                                const val = row[i];
                                if (val === undefined || val === null || val === '') continue;

                                const svalText = String(val).trim().toUpperCase();

                                // Стоп-слова: дошли до Портфеля (1F018...)
                                if (svalText.includes('1F018') || svalText.includes('ПОРТФЕЛЬ')) {
                                    break;
                                }

                                // Пропускаем названия валют комиссий и текст РЕПО
                                if (['RUB', 'USD', 'EUR', 'CNY'].includes(svalText) || svalText.includes('РЕПО') || svalText.includes('НОМЕР')) {
                                    continue;
                                }

                                if (typeof val === 'number') {
                                    if (val < 1000000) {
                                        totalFee += val;
                                        feeFound = true;
                                    } else {
                                        continue; // Это номер сделки (>1 млн), пропускаем
                                    }
                                } else {
                                    const strNum = String(val).replace(/\s/g, '').replace(',', '.');
                                    const n = parseFloat(strNum);
                                    if (!isNaN(n) && typeof val !== 'boolean') {
                                        if (n < 1000000) {
                                            totalFee += n;
                                            feeFound = true;
                                        } else {
                                            continue; // Номер сделки
                                        }
                                    }
                                }
                            }
                            if (feeFound) fee = totalFee;
                        }

                        console.log(`[PARSED] ${dateStr} | ${operation} | ${name} | regDate=${registrationDate} | curr=${currency} | fee=${fee}`);

                        results.push({
                            period: registrationDate || dateStr,
                            operationType: operation,
                            name,
                            regNum,
                            isin,
                            amount,
                            quantity,
                            currency,
                            registrationDate,
                            fee,
                            debit_account: '',
                            credit_account: ''
                        });
                    }
                }
            }
        }
    });

    return results;
}

// Новая логика парсинга ДЕПО (PDF)
async function parseDepo(filePath, fileName = '') {
    if (!fs.existsSync(filePath)) return [];

    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);

    const lines = pdfData.text.split('\n').map(l => l.trim()).filter(l => l !== '');
    const results = [];

    let accountFromFilename = '';
    const match = fileName.match(/\(([^)]+)\)/);
    if (match) {
        accountFromFilename = match[1].trim();
    } else {
        const fallbackMatch = fileName.match(/\b(\d+)\b/);
        if (fallbackMatch) accountFromFilename = fallbackMatch[1].trim();
    }
    console.log(`[DEPO PARSE] fileName: "${fileName}", account extracted: "${accountFromFilename}"`);

    let currentName = '';
    let currentRegNum = '';
    let currentIsin = '';

    console.log(`--- Парсинг ДЕПО (PDF) --- Файл: ${filePath}`);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Ищем название бумаги
        if (line.includes('(Наименование эмитента, тип ценных бумаг)')) {
            currentName = lines[i - 1] || '';
            continue;
        }

        // Ищем рег номер или ISIN
        if (line.includes('(Номер гос. регистрации выпуска/ISIN-код/номер ПДУ/Номер закладной)')) {
            const val = (lines[i - 1] || '').trim();
            // ISIN обычно 12 символов (RU000...), Рег номер длиннее или с дефисами
            if (/^[A-Z0-9]{12}$/.test(val)) {
                currentIsin = val;
                currentRegNum = '';
            } else {
                currentRegNum = val;
                currentIsin = '';
            }
            continue;
        }

        // Ищем строки операций
        if (line === 'Зачисление ЦБ' || line === 'Списание ЦБ') {
            const opType = line;
            // Дата обычно строкой выше: "11.03.2025 25031104310"
            const prevLine = lines[i - 1] || '';
            const dateMatch = prevLine.match(/^(\d{2}\.\d{2}\.\d{4})/);
            const dateStr = dateMatch ? dateMatch[1] : '';

            // Ищем количество ниже, оно обычно перед "Отчет №"
            let quantity = 0;
            for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
                const nextLine = lines[j];
                // Паттерн: "10 000Отчет No..." или "1 000Отчет No..." (без пробела между числом и словом)
                const qtyMatch = nextLine.match(/^([\d\s]+)[Оо]тчет\s*[N№No]/);
                if (qtyMatch) {
                    quantity = parseFloat(qtyMatch[1].replace(/\s/g, ''));
                    break;
                }
            }

            if (dateStr && (currentName || currentRegNum || currentIsin)) {
                results.push({
                    period: dateStr,
                    operationType: opType,
                    name: currentName,
                    regNum: currentRegNum,
                    isin: currentIsin,
                    amount: 0,
                    quantity: quantity,
                    currency: 'RUB',
                    registrationDate: dateStr,
                    fee: 0,
                    debit_account: accountFromFilename,
                    credit_account: ''
                });
            }
        }
    }

    console.log(`[DEPO] Распознано записей: ${results.length}`);
    return results;
}

app.post('/upload', upload.array('files'), async (req, res) => {
    const type = String(req.body.type || 'uk').toLowerCase();
    const mode = req.body.mode || 'overwrite';

    let sourceName = 'UK';
    if (type === 'broker') sourceName = 'Broker';
    else if (type === 'depo') sourceName = 'DEPO';

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (mode === 'overwrite') {
            await client.query('DELETE FROM trades WHERE source = $1', [sourceName]);
        }

        let ruleJson = null;
        if (req.body.ruleJson && String(req.body.ruleJson).trim() !== '') {
            const validated = parseAndValidateUkRuleJsonString(req.body.ruleJson);
            if (!validated.ok) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: validated.errors.join('; ') });
            }
            ruleJson = validated.rule;
        }

        for (const file of req.files) {
            try { file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8'); } catch (e) { }
            console.log('[UPLOAD] file.originalname =', file.originalname);
            let results = [];
            if (ruleJson && type === 'uk') {
                results = smartParseUK(file.path, ruleJson);
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
                    const o = idx * 12; // 12 параметров
                    values.push(
                        c.period, c.operationType || '', c.name, c.regNum, c.isin,
                        c.quantity, c.amount, c.currency, c.registrationDate, c.fee,
                        c.debit_account, c.credit_account
                    );
                    return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8}, $${o + 9}, $${o + 10}, $${o + 11}, $${o + 12}, '${sourceName}')`;
                }).join(',');

                await client.query(`INSERT INTO trades 
                    (period, operation_type, security_name, reg_number, isin, quantity, amount, currency, registration_date, fee, debit_account, credit_account, source) 
                    VALUES ${placeholders}`, values);
            }
        }
        await client.query('COMMIT');

        const finalResult = await client.query('SELECT * FROM trades WHERE source = $1 ORDER BY id ASC', [sourceName]);
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

    const s = source.toLowerCase();
    const sourceName = (s === 'uk') ? 'UK' : (s === 'broker' ? 'Broker' : 'DEPO');

    try {
        await pool.query('DELETE FROM trades WHERE source = $1', [sourceName]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/trades', async (req, res) => {
    let { source } = req.query;
    if (source) {
        const s = source.toLowerCase();
        source = (s === 'uk') ? 'UK' : (s === 'broker' ? 'Broker' : 'DEPO');
    }
    try {
        const query = source
            ? { text: 'SELECT * FROM trades WHERE source = $1 ORDER BY id ASC', values: [source] }
            : { text: 'SELECT * FROM trades ORDER BY id ASC' };

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
app.get('/audit/preview', async (req, res) => {
    try {
        const [ukRes, brokerRes, depoRes] = await Promise.all([
            pool.query("SELECT id, period, registration_date, operation_type, security_name, reg_number, isin, quantity, amount FROM trades WHERE source = 'UK' ORDER BY period, id"),
            pool.query("SELECT id, period, registration_date, operation_type, security_name, reg_number, isin, quantity FROM trades WHERE source = 'Broker'"),
            pool.query("SELECT id, period, registration_date, operation_type, security_name, reg_number, isin, quantity FROM trades WHERE source = 'DEPO' ORDER BY period, id")
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
app.get('/audit', async (req, res) => {
    try {
        const debug = req.query.debug === '1' || req.query.debug === 'true';

        const [ukRes, brokerRes, depoRes] = await Promise.all([
            pool.query("SELECT * FROM trades WHERE source = 'UK' ORDER BY period ASC"),
            pool.query("SELECT * FROM trades WHERE source = 'Broker'"),
            pool.query("SELECT * FROM trades WHERE source = 'DEPO'")
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
app.listen(PORT, () => console.log(`Сервер Асоль на порту ${PORT}`));
