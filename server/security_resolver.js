/**
 * Нормализация «бумаги» для аудита ОПИФ и похожих сверок.
 * Строит единые match-ключи: ISIN > полный regNum > coreName+suffix > coreName.
 */

const ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{10})\b/i;
const ISIN_LABEL_RE = /ISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})/i;
const FULL_REG_RE = /(\d[\dА-Яа-яA-Za-z]{0,3}-\d{2}-\d{4,6}-[А-ЯA-Z\d-]+)/i;
const SHORT_REG_RE = /\b(\d{7,9}[A-Z])\b/;

function normalizeSecurityName(val) {
    let s = String(val ?? '')
        .toLowerCase()
        .replace(/[«»"'`]/g, '')
        .replace(/[,.;]/g, ' ');
    const orgForms = /(?:^|\s)(?:пао|pao|ао|ao|оао|ооо|зао|ап|аp|нпао)(?:\s|$)/gi;
    s = s.replace(orgForms, ' ');
    return s.replace(/\s+/g, ' ').trim();
}

function normReg(val) {
    return String(val ?? '')
        .trim()
        .toUpperCase()
        .replace(/[\s-]/g, '');
}

function normIsin(val) {
    return String(val ?? '')
        .trim()
        .toUpperCase()
        .replace(/\s/g, '');
}

function isFullRegNum(val) {
    const s = String(val ?? '').trim();
    return FULL_REG_RE.test(s) || SHORT_REG_RE.test(s);
}

function normalizeRegSuffix(val) {
    return String(val ?? '').trim().toLowerCase();
}

function isShortRegSuffix(val) {
    const s = String(val ?? '').trim();
    if (!s || s.length > 6) return false;
    if (isFullRegNum(s)) return false;
    return /^[а-яёa-z0-9]+$/i.test(s);
}

function pickField(row, names = []) {
    if (!row) return '';
    for (const n of names) {
        if (row[n] != null && String(row[n]).trim() !== '') return String(row[n]).trim();
    }
    return '';
}

function extractFromSecurityText(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return { name: '', regNum: '', isin: '' };

    const isinMatch = raw.match(ISIN_LABEL_RE) || raw.match(ISIN_RE);
    const isin = isinMatch ? isinMatch[1].toUpperCase() : '';

    const regMatch = raw.match(FULL_REG_RE) || (!isin ? raw.match(SHORT_REG_RE) : null);
    const regNum = regMatch ? regMatch[1] : '';

    let name = raw;
    if (isinMatch) name = name.split(isinMatch[0])[0];
    if (regMatch) name = name.replace(regMatch[0], '');
    name = name.replace(/ISIN/gi, '').replace(/[№\u2116]\s*/g, '').trim();
    name = name.replace(/[\s,;|]+$/, '').trim();

    return { name, regNum, isin };
}

/**
 * @param {'uk'|'broker'|'depo'|'unknown'} side
 */
function resolveRawSecurity(row, side = 'unknown') {
    let name = pickField(row, ['name', 'security_name', 'Название', 'бумага', 'ценная бумага']);
    let regNum = pickField(row, ['regNum', 'reg_num', 'reg_number', 'рег']);
    let isin = pickField(row, ['isin', 'ISIN']);

    const embedded = extractFromSecurityText(name);
    if (embedded.isin && !isin) isin = embedded.isin;
    if (embedded.regNum && !regNum) regNum = embedded.regNum;
    if (embedded.name && (embedded.isin || embedded.regNum || name.length > embedded.name.length + 5)) {
        name = embedded.name;
    }

    if (side === 'uk' || !isFullRegNum(regNum)) {
        const analytics = pickField(row, ['Аналитика Дт', 'analytics', 'analytics_dt']);
        if (analytics) {
            const parts = analytics.split(',').map((s) => s.trim()).filter(Boolean);
            if (parts.length > 1) {
                const suffix = parts[parts.length - 1];
                const coreFromAnalytics = parts.slice(0, -1).join(', ') || analytics;
                if (!name || name === analytics) name = coreFromAnalytics;
                if (isShortRegSuffix(suffix) && !isFullRegNum(regNum)) regNum = suffix;
            }
        }
        if (name.includes(',') && !isFullRegNum(regNum)) {
            const parts = name.split(',').map((s) => s.trim()).filter(Boolean);
            if (parts.length > 1 && isShortRegSuffix(parts[parts.length - 1])) {
                regNum = regNum || parts[parts.length - 1];
                name = parts.slice(0, -1).join(', ');
            }
        }
    }

    const coreName = normalizeSecurityName(name);
    const regSuffix = isShortRegSuffix(regNum) ? normalizeRegSuffix(regNum) : '';
    const regNumFull = isFullRegNum(regNum) ? normReg(regNum) : '';

    return {
        name,
        coreName,
        regNum,
        regNumFull,
        regSuffix,
        isin: normIsin(isin),
    };
}

function buildSecurityCrosswalk(rowSets = []) {
    const regToIsin = new Map();
    const isinToReg = new Map();

    for (const rows of rowSets) {
        for (const row of rows || []) {
            const raw = resolveRawSecurity(row);
            if (raw.regNumFull && raw.isin) {
                regToIsin.set(raw.regNumFull, raw.isin);
                isinToReg.set(raw.isin, raw.regNumFull);
            }
        }
    }

    return { regToIsin, isinToReg };
}

function enrichSecurity(raw, crosswalk = {}) {
    const { regToIsin = new Map(), isinToReg = new Map() } = crosswalk;
    let { isin, regNumFull, regSuffix, coreName, regNum, name } = raw;

    if (!isin && regNumFull && regToIsin.has(regNumFull)) {
        isin = regToIsin.get(regNumFull);
    }
    if (!regNumFull && isin && isinToReg.has(isin)) {
        regNumFull = isinToReg.get(isin);
    }

    return {
        name,
        coreName,
        regNum,
        regNumFull,
        regSuffix,
        isin,
    };
}

function buildSecurityMatchKeys(resolved) {
    const keys = [];
    if (resolved.isin) keys.push(`isin:${resolved.isin}`);
    if (resolved.regNumFull) keys.push(`reg:${resolved.regNumFull}`);
    if (resolved.coreName && resolved.regSuffix) {
        keys.push(`name:${resolved.coreName}|${resolved.regSuffix}`);
    }
    if (resolved.coreName) keys.push(`name:${resolved.coreName}`);
    return [...new Set(keys.filter(Boolean))];
}

function primaryMatchBy(resolved) {
    if (resolved.isin) return 'isin';
    if (resolved.regNumFull) return 'regNum';
    if (resolved.coreName && resolved.regSuffix) return 'name+suffix';
    if (resolved.coreName) return 'name';
    return 'none';
}

function inferSideFromMeta(meta = {}) {
    const hay = `${meta.scenarioId || ''} ${meta.label || ''} ${meta.role || ''}`.toLowerCase();
    if (/broker|брокер/.test(hay)) return 'broker';
    if (/depo|депо/.test(hay)) return 'depo';
    if (/uk|карт|58\.1|journal/.test(hay)) return 'uk';
    return 'unknown';
}

/**
 * @param {object} row
 * @param {object} [options]
 * @param {'uk'|'broker'|'depo'|'unknown'} [options.side]
 * @param {object} [options.crosswalk]
 */
function resolveSecurity(row, options = {}) {
    const side = options.side || inferSideFromMeta(options);
    const raw = resolveRawSecurity(row, side);
    const enriched = enrichSecurity(raw, options.crosswalk || {});
    const matchKeys = buildSecurityMatchKeys(enriched);
    const securityKey = matchKeys[0] || '';

    return {
        ...enriched,
        securityKey,
        matchKeys,
        matchBy: primaryMatchBy(enriched),
    };
}

function enrichRowWithSecurity(row, options = {}) {
    const sec = resolveSecurity(row, options);
    return {
        ...row,
        _security_key: sec.securityKey,
        _security_match_keys: sec.matchKeys,
        _security_match_by: sec.matchBy,
        _security_core_name: sec.coreName,
        _security_isin: sec.isin,
        _security_reg_num: sec.regNumFull || sec.regNum,
    };
}

function enrichTableWithSecurity(table, options = {}) {
    const headers = [...(table.headers || [])];
    const extra = [
        '_security_key',
        '_security_match_by',
        '_security_core_name',
        '_security_isin',
        '_security_reg_num',
    ];
    for (const h of extra) {
        if (!headers.includes(h)) headers.push(h);
    }
    const rows = (table.rows || []).map((row) => enrichRowWithSecurity(row, options));
    return { headers, rows };
}

module.exports = {
    normalizeSecurityName,
    normReg,
    normIsin,
    isFullRegNum,
    extractFromSecurityText,
    resolveRawSecurity,
    buildSecurityCrosswalk,
    enrichSecurity,
    buildSecurityMatchKeys,
    primaryMatchBy,
    resolveSecurity,
    enrichRowWithSecurity,
    enrichTableWithSecurity,
};
