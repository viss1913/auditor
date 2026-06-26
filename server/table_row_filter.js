function normalizeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9]+/g, ' ')
        .trim();
}

function resolveColumnHint(hint, headers) {
    const requestedNorm = normalizeText(hint);
    if (!requestedNorm || !headers?.length) return null;

    const headerNorms = headers.map((h) => ({ header: h, norm: normalizeText(h) }));
    let hit =
        headerNorms.find((x) => x.norm === requestedNorm)?.header ||
        headerNorms.find((x) => requestedNorm && x.norm.includes(requestedNorm))?.header ||
        headerNorms.find((x) => requestedNorm && requestedNorm.includes(x.norm))?.header;

    if (!hit) {
        const aliasMap = {
            группа: 'Группа',
            подразделение: 'Подразделение',
            ос: 'ОС',
            год: 'Год',
            тип: 'тип',
            наименование: 'ОС',
            объект: 'Объект',
            обьект: 'Объект',
        };
        const alias = aliasMap[requestedNorm];
        if (alias) hit = headerNorms.find((x) => x.norm === normalizeText(alias))?.header;
    }
    return hit || null;
}

const ALLOWED_OPS = new Set([
    'eq',
    'ne',
    'contains',
    'starts_with',
    'gt',
    'lt',
    'gte',
    'lte',
    'empty',
    'not_empty',
]);

const COLUMN_ALIASES = {
    debit_account: ['debit_account', 'дебет', 'дт', 'счет дт', 'счёт дт'],
    credit_account: ['credit_account', 'кредит', 'кт', 'счет кт', 'счёт кт'],
    operation_type: ['operation_type', 'операция', 'тип операции', 'вид операции'],
    name: ['name', 'наименование'],
    instrument: ['instrument', 'инструмент', 'бумага', 'ценная бумага', 'актив'],
    quantity: ['quantity', 'количество', 'кол'],
    amount: ['amount', 'сумма', 'б у', 'бу'],
    period: ['period', 'дата', 'период'],
    counterparty: ['counterparty', 'контрагент'],
    document: ['document', 'документ'],
    description: ['description', 'описание', 'описание операции'],
    deal: ['deal', 'сделка', 'номер сделки', '№ сделки'],
    portfolio: ['portfolio', 'портфель'],
    broker_account: ['broker_account', 'счет', 'счёт', 'номер брокерского счета клиента'],
    contract: ['contract', 'договор', 'договор о брокерском обслуживании'],
    sum_rub: ['sum_rub', 'сумма', 'сумма руб', 'сумма, руб.'],
};

function resolveFilterColumn(hint, headers) {
    const h = String(hint || '').trim();
    if (!h) return null;
    if (headers?.includes(h)) return h;

    const fromHint = resolveColumnHint(h, headers);
    if (fromHint) return fromHint;

    const norm = normalizeText(h);
    for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (headers?.includes(canonical) && aliases.some((a) => normalizeText(a) === norm)) {
            return canonical;
        }
        if (aliases.some((a) => normalizeText(a) === norm || norm.includes(normalizeText(a)))) {
            if (headers?.includes(canonical)) return canonical;
            const headerHit = headers?.find((h) => normalizeText(h) === norm || aliases.some((a) => normalizeText(a) === normalizeText(h)));
            if (headerHit) return headerHit;
        }
    }
    return fromHint || (headers?.includes(h) ? h : isSafeColumnName(h) ? h : null);
}

function isSafeColumnName(name) {
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(String(name || ''));
}

function isAllowedFilterColumn(column, headers) {
    if (!column) return false;
    if (headers?.includes(column)) return true;
    return isSafeColumnName(column);
}

function sanitizeFilterClause(raw, headers) {
    if (!raw || typeof raw !== 'object') return null;
    const column = resolveFilterColumn(raw.column || raw.col, headers);
    if (!isAllowedFilterColumn(column, headers)) return null;

    let op = String(raw.op || raw.operator || 'eq').trim().toLowerCase();
    if (!ALLOWED_OPS.has(op)) op = 'eq';

    let value = raw.value;
    if (value != null && typeof value !== 'string' && typeof value !== 'number') {
        value = String(value);
    }
    if (value != null && typeof value === 'string') value = value.trim();

    if (op === 'empty' || op === 'not_empty') {
        return { column, op, value: null };
    }
    if (value == null || value === '') return null;

    return { column, op, value: String(value) };
}

function sanitizeFilterPlan(raw, headers) {
    const modeRaw = String(raw?.mode || 'keep').trim().toLowerCase();
    const mode = modeRaw === 'remove' || modeRaw === 'drop' || modeRaw === 'exclude' ? 'remove' : 'keep';
    const combine = String(raw?.combine || 'and').trim().toLowerCase() === 'or' ? 'or' : 'and';

    const filters = (Array.isArray(raw?.filters) ? raw.filters : [])
        .map((f) => sanitizeFilterClause(f, headers))
        .filter(Boolean);

    return { mode, combine, filters };
}

function matchesDimensionValue(cell, value) {
    const c = normalizeText(cell);
    const v = normalizeText(value);
    if (!c || !v) return false;
    if (c === v) return true;
    if (/^\d+$/.test(v)) {
        const tokens = c.split(/\s+/).filter(Boolean);
        return tokens.length > 0 && tokens[tokens.length - 1] === v;
    }
    return false;
}

function rowMatchesFilter(row, clause) {
    const raw = row?.[clause.column];
    const cell = raw == null ? '' : String(raw).trim();
    const val = clause.value == null ? '' : String(clause.value).trim();

    switch (clause.op) {
        case 'eq':
            if (matchesDimensionValue(cell, val)) return true;
            return cell === val || cell.startsWith(val);
        case 'ne':
            return cell !== val && !cell.startsWith(val);
        case 'contains':
            return normalizeText(cell).includes(normalizeText(val));
        case 'starts_with':
            return cell.startsWith(val);
        case 'empty':
            return cell === '';
        case 'not_empty':
            return cell !== '';
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const a = parseFloat(cell.replace(/\s/g, '').replace(',', '.'));
            const b = parseFloat(val.replace(/\s/g, '').replace(',', '.'));
            if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
            if (clause.op === 'gt') return a > b;
            if (clause.op === 'gte') return a >= b;
            if (clause.op === 'lt') return a < b;
            return a <= b;
        }
        default:
            return false;
    }
}

function rowMatchesFilters(row, { filters, combine }) {
    if (!filters?.length) return true;
    if (combine === 'or') {
        return filters.some((f) => rowMatchesFilter(row, f));
    }
    return filters.every((f) => rowMatchesFilter(row, f));
}

function applyFilterToRows(rows, plan) {
    const sanitized = sanitizeFilterPlan(plan, Object.keys(rows[0] || {}));
    if (!sanitized.filters.length) {
        return { rows, removed: 0, kept: rows.length, plan: sanitized };
    }

    const next = rows.filter((row) => {
        const match = rowMatchesFilters(row, sanitized);
        return sanitized.mode === 'keep' ? match : !match;
    });

    return {
        rows: next,
        removed: rows.length - next.length,
        kept: next.length,
        plan: sanitized,
    };
}

function buildJsonbCondition(clause, paramOffset) {
    const col = clause.column;
    const path = `data->>'${col.replace(/'/g, "''")}'`;
    const params = [];
    let sql = '';

    switch (clause.op) {
        case 'eq':
            params.push(clause.value);
            sql = `(${path} = $${paramOffset} OR ${path} LIKE $${paramOffset + 1})`;
            params.push(`${clause.value}%`);
            return { sql, params, nextOffset: paramOffset + 2 };
        case 'ne':
            params.push(clause.value);
            sql = `(${path} IS DISTINCT FROM $${paramOffset} AND ${path} NOT LIKE $${paramOffset + 1})`;
            params.push(`${clause.value}%`);
            return { sql, params, nextOffset: paramOffset + 2 };
        case 'contains':
            params.push(`%${clause.value}%`);
            sql = `${path} ILIKE $${paramOffset}`;
            return { sql, params, nextOffset: paramOffset + 1 };
        case 'starts_with':
            params.push(`${clause.value}%`);
            sql = `${path} LIKE $${paramOffset}`;
            return { sql, params, nextOffset: paramOffset + 1 };
        case 'empty':
            sql = `(${path} IS NULL OR TRIM(${path}) = '')`;
            return { sql, params, nextOffset: paramOffset };
        case 'not_empty':
            sql = `(${path} IS NOT NULL AND TRIM(${path}) <> '')`;
            return { sql, params, nextOffset: paramOffset };
        case 'gt':
        case 'gte':
        case 'lt':
        case 'lte': {
            const castPath = `NULLIF(REPLACE(REPLACE(${path}, ' ', ''), ',', '.'), '')::numeric`;
            params.push(clause.value);
            const opMap = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
            sql = `${castPath} ${opMap[clause.op]} $${paramOffset}::numeric`;
            return { sql, params, nextOffset: paramOffset + 1 };
        }
        default:
            return { sql: 'TRUE', params, nextOffset: paramOffset };
    }
}

/**
 * SQL для DELETE строк snapshot: mode keep → удалить НЕ совпадающие; remove → удалить совпадающие.
 */
function buildFilterDeleteQuery(snapshotId, plan, headers = []) {
    const { mode, combine, filters } = sanitizeFilterPlan(plan, headers);
    if (!filters.length) {
        return { sql: null, params: [], plan: { mode, combine, filters } };
    }

    const parts = [];
    const params = [snapshotId];
    let offset = 2;

    for (const clause of filters) {
        const built = buildJsonbCondition(clause, offset);
        parts.push(built.sql);
        params.push(...built.params);
        offset = built.nextOffset;
    }

    const matchExpr = parts.length === 1 ? parts[0] : `(${parts.join(combine === 'or' ? ' OR ' : ' AND ')})`;
    const deleteWhen = mode === 'keep' ? `NOT (${matchExpr})` : matchExpr;

    const sql = `DELETE FROM parsed_rows WHERE snapshot_id = $1 AND ${deleteWhen}`;
    return { sql, params, plan: { mode, combine, filters } };
}

function inferFilterOp(column, value) {
    const v = String(value || '').trim();
    if (!v) return 'eq';
    if (column === 'name' || column === 'document' || column === 'operation_type') return 'contains';
    if (/[а-яa-z]/i.test(v)) return 'contains';
    return 'eq';
}

function isFilterContinuation(text) {
    const t = String(text || '').trim();
    return (
        /^(?:а|и|ну|так)?\s*(?:еще|ещё|тогда|также|добавь|плюс)/i.test(t) ||
        /только\s+по(?:\s|=|:|$)/i.test(t) ||
        /добавь\s+услов/i.test(t) ||
        /и\s+ещ[её]?\s+только/i.test(t)
    );
}

function mergeFilterPlans(basePlan, addPlan) {
    const base = sanitizeFilterPlan(basePlan, []);
    const add = sanitizeFilterPlan(addPlan, []);
    const seen = new Set();
    const filters = [];
    for (const f of [...base.filters, ...add.filters]) {
        const key = `${f.column}|${f.op}|${f.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        filters.push(f);
    }
    return {
        mode: add.mode || base.mode || 'keep',
        combine: 'and',
        filters,
    };
}

function extractQuotedOrPlainValue(raw) {
    const s = String(raw || '').trim();
    const quoted = s.match(/^["«'](.+)["»']$/);
    if (quoted) return quoted[1].trim();
    return s.replace(/\s+(?:и|а)\s+[a-z_][a-z0-9_]*\s*=.*$/i, '').trim();
}

function isNotEmptyFilterSignal(text) {
    const t = String(text || '');
    return (
        /есть\s+значен/i.test(t) ||
        /заполнен\w*/i.test(t) ||
        /не\s+пуст\w*/i.test(t) ||
        /непуст\w*/i.test(t) ||
        /has\s+value/i.test(t) ||
        /not\s+empty/i.test(t)
    );
}

function isRowFilterIntent(text) {
    const t = String(text || '');
    return (
        /фильтр/i.test(t) ||
        /оставь\s+(?:только|строк)/i.test(t) ||
        /только\s+(?:строк|если|где|по)/i.test(t) ||
        /(?:убер|удал)\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)/i.test(t) ||
        /исключ\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)/i.test(t) ||
        /where\s+/i.test(t) ||
        /(?:где|если)\s+.+(?:пуст\w*|пусто|не\s+заполн)/i.test(t) ||
        (isNotEmptyFilterSignal(t) && /(?:колонк|где|если|оставь|только|строк)/i.test(t)) ||
        /\bname\s*=/i.test(t) ||
        /debit[_\s]?account\s*=/i.test(t) ||
        /credit[_\s]?account\s*=/i.test(t)
    );
}

function isRowFilterNotColumnEdit(text) {
    const t = String(text || '');
    return (
        /(?:убер|удал)\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)\s+где/i.test(t) ||
        /(?:где|если)\s+.+(?:пуст\w*|пусто|не\s+заполн)/i.test(t)
    );
}

function extractColumnHintFromFilterPart(part) {
    let p = String(part || '').trim();
    p = p
        .replace(/\s+(?:не\s+)?пуст\w*\.?$/i, '')
        .replace(/\s+заполнен\w*\.?$/i, '')
        .trim();
    const colMatch = p.match(/^(?:в\s+)?(?:колонк[еиуа]\s+)?(.+)$/i);
    return (colMatch?.[1] || p).trim();
}

function extractNotEmptyColumnFilters(text, headers) {
    const t = String(text || '');
    if (!isNotEmptyFilterSignal(t)) return [];

    const filters = [];
    const seen = new Set();

    const pushNotEmpty = (hint) => {
        const col = resolveFilterColumn(String(hint || '').trim(), headers);
        if (!col || !headers?.includes(col) || seen.has(col)) return;
        seen.add(col);
        filters.push({ column: col, op: 'not_empty', value: null });
    };

    const valueInCol = t.match(
        /есть\s+значен\w*\s+(?:в\s+)?(?:колонк[еиуа]\s+)?["«']?([^"»'\n,.]+?)["»']?(?:\s|$|\.)/i
    );
    if (valueInCol) pushNotEmpty(valueInCol[1]);

    const filledCol = t.match(
        /(?:колонк[еиуа]\s+)?["«']?([^"»'\n,.]+?)["»']?\s+заполнен\w*/i
    );
    if (filledCol) pushNotEmpty(filledCol[1]);

    let tail = t;
    const where = t.match(/(?:где|если|котор\w*|там\s+где)\s+(.+)$/i);
    if (where) tail = where[1];

    const parts = tail
        .split(/\s*,\s*|\s+и\s+(?=(?:в\s+)?(?:колонк[еиуа]\s+)?)/i)
        .map((s) => s.trim())
        .filter(Boolean);

    for (const part of parts) {
        if (!/(?:не\s+пуст\w*|заполнен\w*|есть\s+значен)/i.test(part)) continue;
        const hint = extractColumnHintFromFilterPart(part);
        if (!hint || /^(где|если|там|есть|значен\w*)$/i.test(hint)) continue;
        pushNotEmpty(hint);
    }

    return filters;
}

function extractEmptyColumnFilters(text, headers) {
    const t = String(text || '');
    if (isNotEmptyFilterSignal(t)) return [];
    if (!/(?:пуст\w*|пусто|не\s+заполн\w*|blank|empty)/i.test(t)) return [];

    let tail = t;
    const where = t.match(/(?:где|если|котор\w*)\s+(.+)$/i);
    if (where) tail = where[1];

    const parts = tail
        .split(/\s*,\s*|\s+и\s+(?=(?:в\s+)?(?:колонк[еиуа]\s+)?)/i)
        .map((s) => s.trim())
        .filter(Boolean);

    const filters = [];
    const seen = new Set();

    for (let part of parts) {
        if (/не\s+пуст\w*/i.test(part)) continue;
        part = part.replace(/\s+пуст\w*\.?$/i, '').trim();
        const hint = extractColumnHintFromFilterPart(part);
        if (!hint || /^(где|если|пуст\w*)$/i.test(hint)) continue;
        const col = resolveFilterColumn(hint, headers);
        if (!col || !headers?.includes(col)) continue;
        if (seen.has(col)) continue;
        seen.add(col);
        filters.push({ column: col, op: 'empty', value: null });
    }

    return filters;
}

function extractColumnFilters(text, headers) {
    const t = String(text || '');
    const filters = [];
    let mode = /убер\S*|удал\S*|исключ|без\s+строк|не\s+оставляй/i.test(t) ? 'remove' : 'keep';

    for (const clause of extractEmptyColumnFilters(t, headers)) {
        if (!filters.some((f) => f.column === clause.column && f.op === clause.op)) {
            filters.push(clause);
        }
    }

    for (const clause of extractNotEmptyColumnFilters(t, headers)) {
        if (!filters.some((f) => f.column === clause.column && f.op === clause.op)) {
            filters.push(clause);
        }
    }

    const patterns = [
        {
            re: /debit[_\s]?account\s*[=:]\s*([\d.]+)/gi,
            column: 'debit_account',
        },
        {
            re: /(?:дт|дебет)(?:\s+счет|\s+счёт)?\s*[=:]?\s*([\d.]+)/gi,
            column: 'debit_account',
        },
        {
            re: /credit[_\s]?account\s*[=:]\s*([\d.]+)/gi,
            column: 'credit_account',
        },
        {
            re: /(?:кт|кредит)(?:\s+счет|\s+счёт)?\s*[=:]?\s*([\d.]+)/gi,
            column: 'credit_account',
        },
    ];

    for (const { re, column } of patterns) {
        let m;
        while ((m = re.exec(t)) !== null) {
            const col = resolveFilterColumn(column, headers) || column;
            filters.push({ column: col, op: 'eq', value: m[1].trim() });
        }
    }

    const colEqNum = /\b([a-z_][a-z0-9_]*)\s*=\s*([\d.]+)/gi;
    let cm;
    while ((cm = colEqNum.exec(t)) !== null) {
        const col = resolveFilterColumn(cm[1], headers);
        if (!col) continue;
        const val = cm[2].trim();
        if (!val) continue;
        if (filters.some((f) => f.column === col && f.value === val)) continue;
        filters.push({ column: col, op: inferFilterOp(col, val), value: val });
    }

    const colEqText =
        /\b([a-z_][a-z0-9_]*)\s*=\s*(?:"([^"]+)"|'([^']+)'|«([^»]+)»)/gi;
    let ct;
    while ((ct = colEqText.exec(t)) !== null) {
        const col = resolveFilterColumn(ct[1], headers);
        if (!col || col === 'name') continue;
        const val = extractQuotedOrPlainValue(ct[2] || ct[3] || ct[4] || '');
        if (!val || /^[\d.]+$/.test(val)) continue;
        if (filters.some((f) => f.column === col && f.value === val)) continue;
        filters.push({ column: col, op: inferFilterOp(col, val), value: val });
    }

    const nameEq = /\bname\s*=\s*(.+)$/i;
    const nameMatch = t.match(nameEq);
    if (nameMatch) {
        const val = extractQuotedOrPlainValue(nameMatch[1]);
        if (val && !filters.some((f) => f.column === 'name' && f.value === val)) {
            const col = resolveFilterColumn('name', headers) || 'name';
            filters.push({ column: col, op: inferFilterOp(col, val), value: val });
        }
    }

    const colEqCyrillic =
        /(?:^|[\s,;—–-])([a-z_а-яё][a-z0-9_а-яё\s]*?)\s*=\s*(?:"([^"]+)"|'([^']+)'|«([^»]+)»|([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9\s.-]+?))(?:\s+и\s+|\s*$|,|\.)/gi;
    let cc;
    while ((cc = colEqCyrillic.exec(t)) !== null) {
        const col = resolveFilterColumn(cc[1].trim(), headers);
        const val = extractQuotedOrPlainValue(cc[2] || cc[3] || cc[4] || cc[5] || '');
        if (!col || !val || /^[\d.]+$/.test(val)) continue;
        if (normalizeText(col) === 'name' && nameMatch) continue;
        if (filters.some((f) => f.column === col && f.value === val)) continue;
        filters.push({ column: col, op: inferFilterOp(col, val), value: val });
    }

    const onlyBy = t.match(/только\s+по\s+([a-z_а-яё_]+)\s*[=:]\s*(.+)$/i);
    if (onlyBy && filters.length === 0) {
        const col = resolveFilterColumn(onlyBy[1], headers);
        const val = extractQuotedOrPlainValue(onlyBy[2]);
        if (col && val && !filters.some((f) => f.column === col && f.value === val)) {
            filters.push({ column: col, op: inferFilterOp(col, val), value: val });
        }
    }

    const colEqualsNatural = t.match(
        /(?:фильтр\s+)?по\s+колонк[еиуа]\s+["«']?([^"»',\n]+?)["»']?(?:\s*,\s*|\s+)(?:значени[еяю]?\s+)?(?:в\s+)?(?:ячейк[аеи]?\s+)?(?:должн[аоы]?\s+)?(?:быть\s+)?равн[оа]?\s+["«']?([A-Za-zА-Яа-яЁё0-9][A-Za-zА-Яа-яЁё0-9\s._()-]*?)["»']?(?:\s+и\s+|\s*$|\.|,)/i
    );
    if (colEqualsNatural) {
        const col = resolveFilterColumn(colEqualsNatural[1].trim(), headers);
        const val = extractQuotedOrPlainValue(colEqualsNatural[2]);
        if (col && val && !filters.some((f) => f.column === col && f.value === val)) {
            filters.push({ column: col, op: 'eq', value: val });
        }
    }

    return { mode, filters };
}

function inferValueFilter(value, headers) {
    const val = String(value || '').trim();
    if (!val) return null;

    const candidates = [
        'name',
        'instrument',
        'Инструмент',
        'security',
        'counterparty',
        'operationType',
        'operation_type',
        'document',
        'Документ',
        'Группа',
    ];
    for (const hint of candidates) {
        const col = resolveFilterColumn(hint, headers);
        if (col && headers?.includes(col)) {
            return { column: col, op: 'contains', value: val };
        }
    }
    if (headers?.length) {
        const col = headers.find((h) => isSafeColumnName(h)) || headers[0];
        return { column: col, op: 'contains', value: val };
    }
    return null;
}

function extractSplitTableLabel(text) {
    const t = String(text || '');
    const quoted =
        t.match(/(?:таблиц[ауеи]|вкладк[ауеи]|лист)\s+["«']([^"»']+)["»']/i) ||
        t.match(/(?:назови|название)\s+["«']([^"»']+)["»']/i);
    if (quoted) return quoted[1].trim();

    const bare = t.match(
        /(?:таблиц[ауеи]|вкладк[ауеи])\s+(?!и\b|с\b|со\b|где\b|все\b)([A-Za-zА-Яа-яЁё0-9._-]+)/i
    );
    if (bare) return bare[1].trim();

    const po = t.match(/(?:данные|строки?)\s+по\s+["«']?([^"»'\n,.]+?)["»']?(?:\s|$|\.)/i);
    if (po) return po[1].trim();

    return null;
}

function isSplitToTableIntent(text) {
    const t = String(text || '').trim();
    const { looksLikeReconcileIntent } = require('./reconcile_intent');
    if (looksLikeReconcileIntent(t)) return false;
    return (
        /(?:сделай|создай|добавь|открой)\s+(?:новую\s+)?(?:таблиц|вкладк|лист)/i.test(t) ||
        /(?:сделай|создай|положи|вынеси)\s+(?:результат\s+)?(?:в\s+)?нов[а-яё]+\s+таблиц/i.test(t) ||
        /(?:результат\s+)?(?:в\s+)?нов[а-яё]+\s+таблиц/i.test(t) ||
        /нов(?:ую|ая|ый)\s+(?:таблиц|вкладк|лист)/i.test(t) ||
        /отдельн\w*\s+таблиц/i.test(t) ||
        /(?:скопируй|перенес\w*)\s+(?:в\s+)?нов/i.test(t) ||
        /(?:вынеси|вытащи)\s+(?:в\s+)?(?:отдельн|нов)/i.test(t)
    );
}

function parseSplitToTableIntent(text, headers = []) {
    const t = String(text || '').trim();
    if (!t || !isSplitToTableIntent(t)) return { action: null };

    const tableLabel = extractSplitTableLabel(t);
    let extracted = extractColumnFilters(t, headers);
    let filters = extracted.filters;

    if (!filters.length) {
        const containsMatch = t.match(
            /(?:где|если)\s+([a-z_а-яё]+)\s+(?:содержит|есть|имеет|=)\s*["«']?([^"»'\n]+?)(?:\s+и\s+(?:перенес|туда|найден)|\s*$|\.)/i
        );
        if (containsMatch) {
            const col = resolveFilterColumn(containsMatch[1], headers);
            const val = extractQuotedOrPlainValue(containsMatch[2]);
            if (col && val) {
                filters = [{ column: col, op: inferFilterOp(col, val), value: val }];
            }
        }
    }

    if (!filters.length) {
        const poMatch = t.match(
            /(?:все\s+)?(?:данные|строки?)?\s*по\s+["«']?([^"»'\n,.]+?)["»']?(?:\s+из|\s+где|\s+где|\s*$|\.)/i
        );
        if (poMatch) {
            const clause = inferValueFilter(poMatch[1].trim(), headers);
            if (clause) filters = [clause];
        }
    }

    return {
        action: 'split_to_table',
        tableLabel,
        mode: extracted.mode || 'keep',
        filters,
        combine: 'and',
        planner: filters.length ? 'regex' : 'regex',
    };
}

function buildSplitAssistantMessage(plan, { tableLabel, rowCount = 0, sourceRowCount = 0 } = {}) {
    const summary = formatFilterSummary(plan);
    const title = tableLabel ? `«${tableLabel}»` : 'новая таблица';
    if (!rowCount) {
        return `**${title}:** ${summary}.\n\nПодходящих строк не нашла — вкладка пустая. Исходная таблица не изменена.`;
    }
    return (
        `**${title}:** ${summary}.\n\n` +
        `Скопировала **${rowCount}** строк из **${sourceRowCount}** в новую вкладку. Исходная таблица не изменена.`
    );
}

function parseFilterIntent(text, headers = []) {
    const t = String(text || '').trim();
    if (!t) return { action: null };
    if (isSplitToTableIntent(t)) return { action: null };

    const filterIntent =
        isRowFilterIntent(t) ||
        isFilterContinuation(t) ||
        (/(?:дт|кт|дебет|кредит)\s*[=:]?\s*[\d.]+/i.test(t) &&
            /(?:оставь|только|фильтр|убери|удали)/i.test(t));

    if (!filterIntent) return { action: null };

    const extracted = extractColumnFilters(t, headers);
    if (extracted.filters.length) {
        return {
            action: 'filter_rows',
            mode: extracted.mode,
            filters: extracted.filters,
            combine: 'and',
            planner: 'regex',
            continuation: isFilterContinuation(t),
        };
    }

    return {
        action: 'filter_rows',
        mode: 'keep',
        filters: [],
        combine: 'and',
        planner: 'regex',
        continuation: isFilterContinuation(t),
    };
}

function formatFilterSummary(plan, headers = null) {
    const modeRaw = String(plan?.mode || 'keep').trim().toLowerCase();
    const mode = modeRaw === 'remove' || modeRaw === 'drop' || modeRaw === 'exclude' ? 'remove' : 'keep';
    const combine = String(plan?.combine || 'and').trim().toLowerCase() === 'or' ? 'or' : 'and';
    let filters = headers ? sanitizeFilterPlan(plan, headers).filters : [];
    if (!filters.length && Array.isArray(plan?.filters)) {
        filters = plan.filters.filter((f) => f?.column && f?.op);
    }
    if (!filters.length) return 'фильтр без условий';
    const cond = filters
        .map((f) => {
            if (f.op === 'empty') return `${f.column} пусто`;
            if (f.op === 'not_empty') return `${f.column} не пусто`;
            return `${f.column} ${f.op} ${f.value}`;
        })
        .join(combine === 'or' ? ' ИЛИ ' : ' И ');
    return mode === 'keep' ? `оставить где ${cond}` : `убрать где ${cond}`;
}

function buildFilterAssistantMessage(plan, { before = 0, after = 0, removed = 0 } = {}) {
    const summary = formatFilterSummary(plan);
    if (before === 0 && after === 0 && removed === 0) {
        return `**Фильтр:** ${summary}.`;
    }
    return `**Фильтр:** ${summary}.\n\nБыло **${before}** строк → осталось **${after}** (убрано ${removed}).`;
}

module.exports = {
    ALLOWED_OPS,
    resolveFilterColumn,
    sanitizeFilterPlan,
    sanitizeFilterClause,
    rowMatchesFilter,
    rowMatchesFilters,
    applyFilterToRows,
    buildFilterDeleteQuery,
    inferFilterOp,
    inferValueFilter,
    isFilterContinuation,
    isSplitToTableIntent,
    mergeFilterPlans,
    extractColumnFilters,
    extractEmptyColumnFilters,
    extractNotEmptyColumnFilters,
    isNotEmptyFilterSignal,
    isRowFilterIntent,
    isRowFilterNotColumnEdit,
    extractSplitTableLabel,
    parseSplitToTableIntent,
    parseFilterIntent,
    formatFilterSummary,
    buildFilterAssistantMessage,
    buildSplitAssistantMessage,
    matchesDimensionValue,
};
