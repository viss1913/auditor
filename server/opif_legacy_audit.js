/**
 * Логика аудита ОПИФ из legacy GET /audit (server/index.js).
 * УК ↔ брокер (построчно), УК ↔ ДЕПО (агрегат), трёхсторонка, enrich depo in-place.
 */

const { buildAuditEnrichHeaders } = require('./audit_report_labels');
const { buildSecurityCrosswalk, resolveSecurity } = require('./security_resolver');

const DEPO_AUDIT_COLUMNS = ['depoFound', 'ukGroupQty', 'depoGroupQty', 'audit_depo', 'audit_depo_comment'];
const THREE_WAY_HEADERS = [
    'registrationDate',
    'operationType',
    'name',
    'regNum',
    'isin',
    'quantity',
    'ukGroupQty',
    'amount',
    'currency',
    'brokerFound',
    'depoFound',
    'depoGroupQty',
    'audit_result',
    'audit_comment',
    'audit_depo',
    'audit_depo_comment',
    'reconcile_status',
];

function norm(s) {
    return String(s ?? '')
        .trim()
        .toUpperCase()
        .replace(/[\s-]/g, '');
}

function fmtDate(d) {
    if (!d) return '';
    if (typeof d === 'string' && /^\d{2}\.\d{2}\.\d{4}/.test(d)) return d.substring(0, 10);
    const dt = d instanceof Date ? d : new Date(d);
    if (Number.isNaN(dt.getTime())) return '';
    const day = String(dt.getUTCDate()).padStart(2, '0');
    const month = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const year = dt.getUTCFullYear();
    return `${day}.${month}.${year}`;
}

function amtEqual(a, b) {
    return Math.abs(parseFloat(a) - parseFloat(b)) < 1.0;
}

function qtyEqual(a, b) {
    return Math.abs(parseFloat(a) - parseFloat(b)) < 0.0001;
}

function isPurchase(type) {
    const t = String(type || '').toLowerCase();
    return t.includes('покупка') || t.includes('зачисление') || t.includes('поступление');
}

function isSale(type) {
    const t = String(type || '').toLowerCase();
    return t.includes('продажа') || t.includes('списание');
}

function resolveOpType(type) {
    if (isPurchase(type)) return 'buy';
    if (isSale(type)) return 'sell';
    return 'other';
}

/** Snapshot-строка → поля как в trades / legacy audit */
function toLegacyRow(row) {
    const r = row || {};
    return {
        period: r.period,
        registration_date: r.registrationDate || r.registration_date || r.period,
        operation_type: r.operationType || r.operation_type || r.document || '',
        security_name: r.name || r.security_name || '',
        reg_number: r.regNum || r.reg_number || '',
        isin: r.isin || '',
        quantity: r.quantity,
        amount: r.amount,
        currency: r.currency || '',
        _raw: r,
    };
}

function buildRegIsinMaps(allRows = []) {
    const regToIsin = new Map();
    const isinToReg = new Map();
    for (const row of allRows) {
        const rn = norm(row.reg_number);
        const isin = norm(row.isin);
        if (rn && isin) {
            regToIsin.set(rn, isin);
            isinToReg.set(isin, rn);
        }
    }
    const getIsin = (rn, isin) => (isin ? norm(isin) : rn ? regToIsin.get(norm(rn)) : '');
    const getRegNum = (rn, isin) => (rn ? norm(rn) : isin ? isinToReg.get(norm(isin)) : '');
    return { regToIsin, isinToReg, getIsin, getRegNum };
}

function findBrokerMatch(uk, brokerRows, maps) {
    const { getIsin, getRegNum } = maps;
    const ukRegDate = fmtDate(uk.registration_date);
    const ukRegNum = getRegNum(uk.reg_number, uk.isin);
    const ukIsin = getIsin(uk.reg_number, uk.isin);
    const ukQty = parseFloat(uk.quantity);
    const ukAmt = parseFloat(uk.amount);
    const ukType = resolveOpType(uk.operation_type);

    return brokerRows.find((b) => {
        const bRegDate = fmtDate(b.registration_date || b.period);
        if (bRegDate !== ukRegDate) return false;

        const bType = resolveOpType(b.operation_type);
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

        if (ukQty === 0 || Number.isNaN(ukQty)) return amtEqual(b.amount, ukAmt);
        return qtyEqual(b.quantity, ukQty) && amtEqual(b.amount, ukAmt);
    });
}

function attachBrokerFields(brokerRow) {
    if (!brokerRow) return {};
    const raw = brokerRow._raw || brokerRow;
    const out = {};
    const cols = [
        'registrationDate',
        'registration_date',
        'period',
        'name',
        'security_name',
        'regNum',
        'reg_number',
        'isin',
        'quantity',
        'amount',
        'operationType',
        'operation_type',
        'currency',
    ];
    const map = {
        registrationDate: raw.registrationDate || raw.registration_date || raw.period,
        period: raw.period,
        name: raw.name || raw.security_name,
        regNum: raw.regNum || raw.reg_number,
        isin: raw.isin,
        quantity: raw.quantity,
        amount: raw.amount,
        operationType: raw.operationType || raw.operation_type,
        currency: raw.currency,
    };
    for (const [k, v] of Object.entries(map)) {
        if (v !== undefined && v !== '') out[`broker_${k}`] = v;
    }
    return out;
}

function buildAuditComment(uk, brokerFound, brokerMatch) {
    if (brokerFound) {
        return 'Сделка найдена в брокере (legacy: дата рег. + тип + reg/ISIN + qty/amount)';
    }
    const regDate = fmtDate(uk.registration_date);
    const type = resolveOpType(uk.operation_type);
    const paper = uk.reg_number || uk.isin || uk.security_name || '?';
    return `Нет сделки брокера: дата ${regDate || '?'}, тип ${type}, бумага ${paper}`;
}

function buildDepoAuditComment(uk, depoFound, ukGroupQty, depoGroupQty) {
    if (depoFound) {
        return `Группа в ДЕПО найдена: УК ${ukGroupQty} = ДЕПО ${depoGroupQty}`;
    }
    const regDate = fmtDate(uk.registration_date);
    const type = resolveOpType(uk.operation_type);
    const paper = uk.reg_number || uk.isin || uk.security_name || '?';
    return `Нет группы в ДЕПО: дата ${regDate || '?'}, тип ${type}, бумага ${paper}, УК ${ukGroupQty}, ДЕПО ${depoGroupQty}`;
}

function buildDepoGroupKeys(rawRow, crosswalk, side = 'unknown') {
    const regDate = fmtDate(rawRow.registrationDate || rawRow.registration_date || rawRow.period);
    const op = resolveOpType(rawRow.operationType || rawRow.operation_type || rawRow.document || '');
    if (!regDate) return [];

    const sec = resolveSecurity(rawRow, { side, crosswalk });
    const keys = [];
    if (sec.regNumFull) keys.push(`${regDate}|${op}|reg:${sec.regNumFull}`);
    if (sec.isin) keys.push(`${regDate}|${op}|isin:${sec.isin}`);
    if (sec.coreName && sec.regSuffix) {
        keys.push(`${regDate}|${op}|name:${sec.coreName}|${sec.regSuffix}`);
    }
    if (sec.coreName) keys.push(`${regDate}|${op}|name:${sec.coreName}`);
    return [...new Set(keys)];
}

function addQtyToKeyMap(map, keys, qty) {
    for (const key of keys) {
        map.set(key, (map.get(key) || 0) + qty);
    }
}

/** @deprecated use buildDepoGroupKeys — оставлено для совместимости тестов */
function buildGroupKey(uk, maps) {
    const { getIsin, getRegNum } = maps;
    const ukRegDate = fmtDate(uk.registration_date);
    const ukRegNum = getRegNum(uk.reg_number, uk.isin);
    const ukIsin = getIsin(uk.reg_number, uk.isin);
    const ukType = resolveOpType(uk.operation_type);
    if (ukRegNum) return `${ukRegDate}|${ukRegNum}|${ukType}`;
    if (ukIsin) return `${ukRegDate}|${ukIsin}|${ukType}`;
    return null;
}

/**
 * @returns {{ ukQtyMap: Map, depoQtyMap: Map, crosswalk: object, maps: object }}
 */
function buildUkDepoQtyMaps(ukRows = [], depoRows = [], extraRows = []) {
    const crosswalk = buildSecurityCrosswalk([ukRows, depoRows, extraRows]);
    const allLegacy = [...ukRows, ...depoRows, ...extraRows].map((r) =>
        typeof r.registration_date !== 'undefined' || r._raw ? r : toLegacyRow(r)
    );
    const maps = buildRegIsinMaps(allLegacy);

    const ukQtyMap = new Map();
    for (const raw of ukRows) {
        const keys = buildDepoGroupKeys(raw, crosswalk, 'uk');
        const qty = parseFloat(raw.quantity) || 0;
        if (keys.length) addQtyToKeyMap(ukQtyMap, keys, qty);
    }

    const depoQtyMap = new Map();
    for (const raw of depoRows) {
        const keys = buildDepoGroupKeys(raw, crosswalk, 'depo');
        const qty = parseFloat(raw.quantity) || 0;
        if (keys.length) addQtyToKeyMap(depoQtyMap, keys, qty);
    }

    return { ukQtyMap, depoQtyMap, crosswalk, maps };
}

function pickUkGroupKey(rawRow, crosswalk, ukQtyMap) {
    const keys = buildDepoGroupKeys(rawRow, crosswalk, 'uk');
    for (const key of keys) {
        if (ukQtyMap.has(key)) return { key, ukGroupQty: ukQtyMap.get(key) };
    }
    const uk = toLegacyRow(rawRow);
    const fallback = buildGroupKey(uk, buildRegIsinMaps([uk]));
    if (fallback && ukQtyMap.has(fallback)) {
        return { key: fallback, ukGroupQty: ukQtyMap.get(fallback) };
    }
    return {
        key: keys[0] || fallback,
        ukGroupQty: parseFloat(rawRow.quantity) || 0,
    };
}

function resolveDepoMatch(rawRow, crosswalk, ukQtyMap, depoQtyMap) {
    const ukQty = parseFloat(rawRow.quantity);
    const keys = buildDepoGroupKeys(rawRow, crosswalk, 'uk');
    const { key: groupKey, ukGroupQty: fromMap } = pickUkGroupKey(rawRow, crosswalk, ukQtyMap);
    const ukGroupQty = fromMap ?? ukQty;

    let depoGroupQty = 0;
    let depoFound = false;
    let matchedKey = null;

    for (const key of keys) {
        if (!depoQtyMap.has(key)) continue;
        matchedKey = key;
        depoGroupQty = depoQtyMap.get(key) || 0;
        if (ukGroupQty === 0 || qtyEqual(depoGroupQty, ukGroupQty)) {
            depoFound = true;
        }
        break;
    }

    return {
        depoFound,
        ukGroupQty,
        depoGroupQty,
        groupKey: matchedKey || groupKey,
    };
}

function buildDepoFields(rawRow, crosswalk, ukQtyMap, depoQtyMap) {
    const uk = toLegacyRow(rawRow);
    const { depoFound, ukGroupQty, depoGroupQty } = resolveDepoMatch(
        rawRow,
        crosswalk,
        ukQtyMap,
        depoQtyMap
    );
    return {
        depoFound,
        ukGroupQty,
        depoGroupQty,
        audit_depo: depoFound ? 'Найдено' : 'Не найдено в ДЕПО',
        audit_depo_comment: buildDepoAuditComment(uk, depoFound, ukGroupQty, depoGroupQty),
    };
}

function buildCombinedReconcileStatus(brokerFound, depoFound) {
    if (brokerFound && depoFound) return 'match';
    if (!brokerFound && !depoFound) return 'only_left';
    return 'value_mismatch';
}

function buildAuditEnrichHeadersWithDepo(leftHeaders = [], rowSample = {}) {
    const base = buildAuditEnrichHeaders(leftHeaders, rowSample);
    const insertAt = base.indexOf('reconcile_status');
    const depoCols = DEPO_AUDIT_COLUMNS.filter(
        (c) => rowSample[c] !== undefined || c === 'depoFound'
    );
    if (insertAt >= 0) {
        return [...base.slice(0, insertAt), ...depoCols, ...base.slice(insertAt)];
    }
    return [...base, ...depoCols];
}

/**
 * @param {{ headers: string[], rows: object[] }} leftTable — УК
 * @param {{ headers: string[], rows: object[] }} brokerTable
 */
function runOpifUkBrokerLegacyAudit(leftTable, brokerTable) {
    const ukLegacy = (leftTable.rows || []).map(toLegacyRow);
    const brokerLegacy = (brokerTable.rows || []).map(toLegacyRow);
    const maps = buildRegIsinMaps([...ukLegacy, ...brokerLegacy]);

    const reportRows = [];
    let matched = 0;
    let onlyLeft = 0;

    for (let i = 0; i < (leftTable.rows || []).length; i++) {
        const orig = leftTable.rows[i];
        const uk = ukLegacy[i];
        const brokerMatch = findBrokerMatch(uk, brokerLegacy, maps);
        const brokerFound = !!brokerMatch;
        const reconcile_status = brokerFound ? 'match' : 'only_left';

        if (brokerFound) matched += 1;
        else onlyLeft += 1;

        reportRows.push({
            ...orig,
            brokerFound,
            audit_result: brokerFound ? 'Найдено' : 'Не найдено в брокере',
            audit_comment: buildAuditComment(uk, brokerFound, brokerMatch),
            audit_match_by_label: brokerFound ? 'legacy: reg/isin + тип + дата' : '',
            reconcile_status,
            _reconcile_mismatch_columns: [],
            ...attachBrokerFields(brokerMatch),
        });
    }

    const headers = buildAuditEnrichHeaders(leftTable.headers || [], reportRows[0] || {});

    return {
        ok: onlyLeft === 0,
        headers,
        rows: reportRows,
        summary: {
            leftCount: (leftTable.rows || []).length,
            rightCount: (brokerTable.rows || []).length,
            matched,
            only_left: onlyLeft,
            only_right: 0,
            value_mismatch: 0,
            reportMode: 'enrich_left',
            securityMatch: false,
            auditScenarioId: 'opif_uk_broker',
            matcher: 'opif_legacy_broker',
        },
    };
}

/**
 * @param {{ headers: string[], rows: object[] }} leftTable — УК
 * @param {{ headers: string[], rows: object[] }} depoTable
 */
function runOpifUkDepoLegacyAudit(leftTable, depoTable) {
    const ukRows = leftTable.rows || [];
    const depoRows = depoTable.rows || [];
    const { ukQtyMap, depoQtyMap, crosswalk } = buildUkDepoQtyMaps(ukRows, depoRows);

    const reportRows = [];
    let matched = 0;
    let onlyLeft = 0;

    for (const orig of ukRows) {
        const depoFields = buildDepoFields(orig, crosswalk, ukQtyMap, depoQtyMap);
        const reconcile_status = depoFields.depoFound ? 'match' : 'only_left';

        if (depoFields.depoFound) matched += 1;
        else onlyLeft += 1;

        reportRows.push({
            ...orig,
            ...depoFields,
            audit_result: depoFields.audit_depo,
            audit_comment: depoFields.audit_depo_comment,
            reconcile_status,
            _reconcile_mismatch_columns: [],
        });
    }

    const headers = buildAuditEnrichHeadersWithDepo(leftTable.headers || [], reportRows[0] || {});

    return {
        ok: onlyLeft === 0,
        headers,
        rows: reportRows,
        summary: {
            leftCount: (leftTable.rows || []).length,
            rightCount: (depoTable.rows || []).length,
            matched,
            only_left: onlyLeft,
            only_right: 0,
            value_mismatch: 0,
            reportMode: 'enrich_left',
            securityMatch: false,
            auditScenarioId: 'opif_uk_depo',
            matcher: 'opif_legacy_depo',
        },
    };
}

/**
 * @param {{ headers: string[], rows: object[] }} ukTable
 * @param {{ headers: string[], rows: object[] }} brokerTable
 * @param {{ headers: string[], rows: object[] }} depoTable
 */
function runOpifThreeWayLegacyAudit(ukTable, brokerTable, depoTable) {
    const ukRows = ukTable.rows || [];
    const brokerRows = brokerTable.rows || [];
    const depoRows = depoTable.rows || [];
    const ukLegacy = ukRows.map(toLegacyRow);
    const brokerLegacy = brokerRows.map(toLegacyRow);
    const brokerMaps = buildRegIsinMaps([...ukLegacy, ...brokerLegacy, ...depoRows.map(toLegacyRow)]);
    const { ukQtyMap, depoQtyMap, crosswalk, maps } = buildUkDepoQtyMaps(
        ukRows,
        depoRows,
        brokerRows
    );

    const reportRows = [];
    let matched = 0;
    let onlyLeft = 0;
    let partial = 0;

    for (let i = 0; i < ukRows.length; i++) {
        const uk = ukLegacy[i];
        const orig = ukRows[i];
        const brokerMatch = findBrokerMatch(uk, brokerLegacy, brokerMaps);
        const brokerFound = !!brokerMatch;
        const depoFields = buildDepoFields(orig, crosswalk, ukQtyMap, depoQtyMap);
        const depoFound = depoFields.depoFound;
        const reconcile_status = buildCombinedReconcileStatus(brokerFound, depoFound);

        if (brokerFound && depoFound) matched += 1;
        else if (!brokerFound && !depoFound) onlyLeft += 1;
        else partial += 1;

        const { getRegNum, getIsin } = maps;
        reportRows.push({
            registrationDate: fmtDate(uk.registration_date),
            operationType: uk.operation_type,
            name: uk.security_name || '',
            regNum: getRegNum(uk.reg_number, uk.isin) || uk.reg_number || '',
            isin: getIsin(uk.reg_number, uk.isin) || uk.isin || '',
            quantity: uk.quantity,
            ukGroupQty: depoFields.ukGroupQty,
            amount: uk.amount,
            currency: uk.currency || '',
            brokerFound,
            depoFound,
            depoGroupQty: depoFields.depoGroupQty,
            audit_result: brokerFound ? 'Найдено' : 'Не найдено в брокере',
            audit_comment: buildAuditComment(uk, brokerFound, brokerMatch),
            audit_depo: depoFields.audit_depo,
            audit_depo_comment: depoFields.audit_depo_comment,
            reconcile_status,
            _reconcile_mismatch_columns: [],
            ...attachBrokerFields(brokerMatch),
        });
    }

    return {
        ok: onlyLeft === 0 && partial === 0,
        headers: THREE_WAY_HEADERS,
        rows: reportRows,
        summary: {
            leftCount: ukLegacy.length,
            rightCount: brokerLegacy.length,
            depoCount: depoRows.length,
            matched,
            only_left: onlyLeft,
            value_mismatch: partial,
            only_right: 0,
            reportMode: 'three_way',
            securityMatch: false,
            auditScenarioId: 'opif_three_way',
            matcher: 'opif_legacy_three',
        },
    };
}

/**
 * Дополнить существующий отчёт аудита колонками ДЕПО (in-place).
 * @param {{ headers: string[], rows: object[] }} auditTable — отчёт с brokerFound
 * @param {{ headers: string[], rows: object[] }} depoTable
 */
function enrichDepoOnAuditRows(auditTable, depoTable) {
    const auditRows = auditTable.rows || [];
    const depoRows = depoTable.rows || [];
    const { ukQtyMap, depoQtyMap, crosswalk } = buildUkDepoQtyMaps(auditRows, depoRows);

    const reportRows = [];
    let depoMatched = 0;

    for (const orig of auditRows) {
        const depoFields = buildDepoFields(orig, crosswalk, ukQtyMap, depoQtyMap);
        const brokerFound = orig.brokerFound === true || orig.brokerFound === 'true';
        const reconcile_status = buildCombinedReconcileStatus(brokerFound, depoFields.depoFound);

        if (depoFields.depoFound) depoMatched += 1;

        reportRows.push({
            ...orig,
            ...depoFields,
            reconcile_status,
        });
    }

    const headers = buildAuditEnrichHeadersWithDepo(auditTable.headers || [], reportRows[0] || {});

    return {
        ok: true,
        headers,
        rows: reportRows,
        summary: {
            leftCount: reportRows.length,
            rightCount: depoRows.length,
            depoMatched,
            reportMode: 'enrich_active',
            securityMatch: false,
            auditScenarioId: 'opif_enrich_depo',
            matcher: 'opif_enrich_depo',
        },
    };
}

module.exports = {
    norm,
    fmtDate,
    toLegacyRow,
    buildRegIsinMaps,
    buildUkDepoQtyMaps,
    buildGroupKey,
    resolveDepoMatch,
    findBrokerMatch,
    runOpifUkBrokerLegacyAudit,
    runOpifUkDepoLegacyAudit,
    runOpifThreeWayLegacyAudit,
    enrichDepoOnAuditRows,
    buildCombinedReconcileStatus,
    DEPO_AUDIT_COLUMNS,
};
