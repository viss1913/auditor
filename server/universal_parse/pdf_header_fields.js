const { safeRegex } = require('./extraction_rule_v1_validate');

function normalizeHeaderFieldDefs(fieldDefs) {
    if (!Array.isArray(fieldDefs)) return [];
    return fieldDefs
        .map((f) => ({
            target: String(f?.target || f?.label || '').trim(),
            label: String(f?.label || f?.target || '').trim(),
            pattern: String(f?.pattern || '').trim(),
            flags: String(f?.flags || 'i').trim() || 'i',
            scope: f?.scope === 'full_page' ? 'full_page' : 'above_data_start',
        }))
        .filter((f) => f.target && f.pattern);
}

function headerScopeText(clusteredRows, dataStartRow, scope) {
    const rows = clusteredRows || [];
    if (scope === 'full_page') {
        return rows.map((r) => String(r?.text || r || '')).join('\n');
    }
    const start = Number.isFinite(dataStartRow) ? dataStartRow : rows.length;
    return rows
        .slice(0, Math.max(0, start))
        .map((r) => String(r?.text || r || ''))
        .join('\n');
}

/**
 * @param {Array<{ text?: string }>|string[]} clusteredRows
 * @param {number} dataStartRow page-level index
 * @param {Array} fieldDefs
 */
function extractHeaderFields(clusteredRows, dataStartRow, fieldDefs) {
    const defs = normalizeHeaderFieldDefs(fieldDefs);
    const out = {};
    for (const def of defs) {
        const haystack = headerScopeText(clusteredRows, dataStartRow, def.scope);
        let value = '';
        try {
            const re = new RegExp(def.pattern, def.flags);
            const m = haystack.match(re);
            if (m) value = String(m[1] != null ? m[1] : m[0] || '').trim();
        } catch {
            /* bad pattern */
        }
        if (value) {
            out[def.label || def.target] = value;
            out[def.target] = value;
        }
    }
    return out;
}

function validateHeaderFieldDefs(fieldDefs) {
    const errors = [];
    const defs = normalizeHeaderFieldDefs(fieldDefs);
    defs.forEach((def, i) => {
        const chk = safeRegex(def.pattern);
        if (!chk.ok) errors.push(`header_fields[${i}].pattern: ${chk.error}`);
    });
    return { ok: !errors.length, errors, defs };
}

/**
 * @param {object[]} rows
 * @param {string[]} headers
 * @param {object} values map label/target → value
 * @param {Array} fieldDefs
 */
function applyHeaderFieldsToRows(rows, headers, values, fieldDefs) {
    const defs = normalizeHeaderFieldDefs(fieldDefs);
    if (!defs.length || !rows?.length) {
        return { headers: headers || [], rows: rows || [] };
    }

    const hdrs = [...(headers || [])];
    for (const def of defs) {
        const col = def.label || def.target;
        if (col && !hdrs.includes(col)) hdrs.push(col);
    }

    const nextRows = (rows || []).map((row) => {
        const out = { ...(row || {}) };
        for (const def of defs) {
            const col = def.label || def.target;
            const val = values?.[col] ?? values?.[def.target] ?? '';
            if (val) out[col] = val;
        }
        return out;
    });

    return { headers: hdrs, rows: nextRows };
}

function parseHeaderFieldsFromBody(body) {
    let raw = body?.header_fields ?? body?.headerFields;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw || '[]');
        } catch {
            return [];
        }
    }
    return normalizeHeaderFieldDefs(raw);
}

function suggestBrokerHeaderFields(clusteredRows = []) {
    const text = clusteredRows.map((r) => String(r?.text || r || '')).join('\n');
    const suggestions = [];
    const add = (field) => {
        if (!field?.label || suggestions.some((s) => s.label === field.label)) return;
        suggestions.push(field);
    };
    if (/клиент\s+[A-Z0-9-]+/i.test(text)) {
        add({
            target: 'client',
            label: 'Клиент',
            pattern: 'клиент\\s+([A-Z0-9-]+)',
            flags: 'i',
            scope: 'above_data_start',
        });
    }
    if (/client\s+code\s*[:.]?\s*(\S+)/i.test(text)) {
        add({
            target: 'client_code',
            label: 'Client Code',
            pattern: 'client\\s+code\\s*[:.]?\\s*(\\S+)',
            flags: 'i',
            scope: 'above_data_start',
        });
    }
    if (/за\s+период|period|\d{2}\.\d{2}\.\d{4}\s*[–-]\s*\d{2}\.\d{2}\.\d{4}/i.test(text)) {
        add({
            target: 'period',
            label: 'Период',
            pattern: '(\\d{2}\\.\\d{2}\\.\\d{4}\\s*[–-]\\s*\\d{2}\\.\\d{2}\\.\\d{4}|(?:за\\s+период|period)\\s*[:.]?\\s*[^\\n]+)',
            flags: 'i',
            scope: 'above_data_start',
        });
    }
    const negUpd = /не\s+упд|not\s+upd|не\s+брокер|не\s+депо/i.test(text);
    if (
        !negUpd &&
        (/(?:счет[- ]?фактур|счёт[- ]?фактур|счфдоп)\s*(?:no|№|#)?\s*\d/i.test(text) ||
            /\bупд\s*(?:no|№|#)?\s*\d/i.test(text))
    ) {
        add({
            target: 'upd_number',
            label: 'УПД №',
            pattern: '(?:Счет-фактура|Счёт-фактура)\\s+No\\s*([\\d/]+(?:/[A-Za-zА-Яа-я])?)',
            flags: 'i',
            scope: 'above_data_start',
        });
    }
    if (/продавец/i.test(text)) {
        add({
            target: 'seller',
            label: 'Продавец',
            pattern: 'Продавец[:\\s]+(.+)',
            flags: 'i',
            scope: 'above_data_start',
        });
    }
    if (/покупатель/i.test(text)) {
        add({
            target: 'buyer',
            label: 'Покупатель',
            pattern: 'Покупатель[:\\s]+(.+)',
            flags: 'i',
            scope: 'above_data_start',
        });
    }
    if (/сч[её]т\s*депо|account\s+no/i.test(text)) {
        add({
            target: 'account',
            label: 'Счёт',
            pattern: '(?:сч[её]т\\s*депо|account\\s+no\\.?)\\s*[:.]?\\s*([A-Z0-9-]+)',
            flags: 'i',
            scope: 'above_data_start',
        });
    }
    return suggestions;
}

module.exports = {
    normalizeHeaderFieldDefs,
    extractHeaderFields,
    validateHeaderFieldDefs,
    applyHeaderFieldsToRows,
    parseHeaderFieldsFromBody,
    suggestBrokerHeaderFields,
    headerScopeText,
};
