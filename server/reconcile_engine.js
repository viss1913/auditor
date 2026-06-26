const { normalizeSecurityName, normReg, normIsin, isFullRegNum } = require('./security_resolver');
const {
    decorateAuditRow,
    buildAuditEnrichHeaders,
} = require('./audit_report_labels');

function normalizeKey(val, column = '') {
    const s = String(val ?? '').trim();
    const dm = s.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (dm) return `${dm[3]}-${dm[2]}-${dm[1]}`;
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return iso[0];
    const col = String(column || '').toLowerCase();
    if (col === 'name') return normalizeSecurityName(s);
    return s.toLowerCase().replace(/\s+/g, ' ');
}

function normalizeNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function numsClose(a, b, eps = 0.01) {
    const na = normalizeNum(a);
    const nb = normalizeNum(b);
    if (na === null && nb === null) return true;
    if (na === null || nb === null) return false;
    return Math.abs(na - nb) <= eps;
}

function applyNormalizers(value, side, column, normalizers = []) {
    let out = value;
    for (const rule of normalizers || []) {
        if (rule.side && rule.side !== side) continue;
        if (rule.column && rule.column !== column) continue;
        const key = normalizeKey(out, column);
        if (rule.map && Object.prototype.hasOwnProperty.call(rule.map, out)) {
            out = rule.map[out];
            continue;
        }
        if (rule.map) {
            const hit = Object.entries(rule.map).find(([k]) => normalizeKey(k, column) === key);
            if (hit) out = hit[1];
        }
    }
    return out;
}

function buildCompositeKey(row, keyColumns = [], side = 'left', normalizers = []) {
    return keyColumns
        .map((col) => {
            const raw = row?.[col];
            const normalized = applyNormalizers(raw, side, col, normalizers);
            return normalizeKey(normalized, col);
        })
        .join('|');
}

function inferValuePairs(leftHeaders, rightHeaders, plan = {}) {
    if (plan.valuePairs?.length) return plan.valuePairs;
    const leftKeys = plan.leftKeys || [];
    const rightKeys = plan.rightKeys || leftKeys;
    const keySet = new Set([...leftKeys, ...rightKeys]);
    const shared = (leftHeaders || []).filter(
        (h) => h && rightHeaders.includes(h) && !keySet.has(h)
    );
    return shared.map((col) => ({ left: col, right: col, tolerance: 0.01 }));
}

function buildRightIndex(rows, rightKeys, normalizers, options = {}) {
    const index = new Map();
    const addRow = (key, row) => {
        if (!key || !key.replace(/\|/g, '')) return;
        if (!index.has(key)) index.set(key, row);
    };
    for (const row of rows || []) {
        addRow(buildCompositeKey(row, rightKeys, 'right', normalizers), row);
        if (options.dateFallback && rightKeys[0] === 'registrationDate' && row.period) {
            const altKeys = ['period', ...rightKeys.slice(1)];
            addRow(buildCompositeKey(row, altKeys, 'right', normalizers), row);
        }
    }
    return index;
}

function regNumsEqual(a, b) {
    if (!isFullRegNum(a) || !isFullRegNum(b)) return true;
    const na = normReg(a);
    const nb = normReg(b);
    if (!na && !nb) return true;
    return na === nb;
}

function compareValuePairs(leftRow, rightRow, valuePairs) {
    const mismatchCols = [];
    for (const pair of valuePairs) {
        const lv = leftRow[pair.left];
        const rv = rightRow[pair.right];
        const col = String(pair.left || '').toLowerCase();
        const tol = Number.isFinite(pair.tolerance) ? pair.tolerance : 0.01;

        let ok;
        if (col === 'regnum') {
            ok = regNumsEqual(lv, rv);
        } else if (col === 'isin') {
            const ni = normIsin(lv);
            const nj = normIsin(rv);
            ok = (!ni && !nj) || ni === nj;
        } else {
            const bothNumeric = normalizeNum(lv) !== null || normalizeNum(rv) !== null;
            ok = bothNumeric ? numsClose(lv, rv, tol) : normalizeKey(lv, pair.left) === normalizeKey(rv, pair.right);
        }
        if (!ok) mismatchCols.push(pair.left);
    }
    return mismatchCols;
}

function getDateParts(row, dateKey, dateFallback) {
    const keys = [dateKey];
    if (dateFallback && dateKey === 'registrationDate' && row?.period) keys.push('period');
    if (dateFallback && dateKey === 'period' && row?.registrationDate) keys.push('registrationDate');
    const parts = [];
    for (const k of keys) {
        const p = normalizeKey(row?.[k], k);
        if (p && !parts.includes(p)) parts.push(p);
    }
    return parts;
}

function buildSecurityRightIndex(rows, plan = {}) {
    const rightDateKey = plan.rightDateKey || plan.rightKeys?.[0] || 'registrationDate';
    const dateFallback = plan.dateFallback !== false;
    const index = new Map();
    for (const row of rows || []) {
        const secKeys = row._security_match_keys?.length
            ? row._security_match_keys
            : row._security_key
              ? [row._security_key]
              : [''];
        for (const dp of getDateParts(row, rightDateKey, dateFallback)) {
            for (const sk of secKeys) {
                const composite = `${dp}|${sk}`;
                if (!index.has(composite)) index.set(composite, { row, securityKey: sk });
            }
        }
    }
    return index;
}

function lookupSecurityRow(leftRow, index, plan = {}) {
    const leftDateKey = plan.leftDateKey || plan.leftKeys?.[0] || 'period';
    const dateFallback = plan.dateFallback !== false;
    const secKeys = leftRow._security_match_keys?.length
        ? leftRow._security_match_keys
        : leftRow._security_key
          ? [leftRow._security_key]
          : [''];
    const dateParts = getDateParts(leftRow, leftDateKey, dateFallback);

    for (const dp of dateParts) {
        for (const sk of secKeys) {
            const hit = index.get(`${dp}|${sk}`);
            if (hit) {
                return {
                    row: hit.row,
                    securityKey: sk,
                    reconcileKey: `${dp}|${sk}`,
                    auditMatchBy: leftRow._security_match_by || 'security',
                };
            }
        }
    }

    const dp = dateParts[0] || '';
    const sk = secKeys[0] || leftRow._security_key || '';
    return { row: null, securityKey: sk, reconcileKey: `${dp}|${sk}`, auditMatchBy: '' };
}

const BROKER_EXPORT_COLS = [
    'registrationDate',
    'period',
    'name',
    'regNum',
    'isin',
    'quantity',
    'amount',
    'operationType',
];

function attachBrokerFields(rightRow, rightKeys, valuePairs) {
    const out = {};
    if (!rightRow) return out;
    for (const col of BROKER_EXPORT_COLS) {
        if (rightRow[col] !== undefined && rightRow[col] !== '') {
            out[`broker_${col}`] = rightRow[col];
        }
    }
    for (const col of rightKeys || []) {
        if (col.startsWith('_')) continue;
        const bh = `broker_${col}`;
        if (out[bh] === undefined) out[bh] = rightRow[col] ?? '';
    }
    for (const pair of valuePairs) {
        out[`broker_${pair.right}`] = rightRow[pair.right] ?? '';
    }
    return out;
}

function buildEnrichLeftHeaders(leftHeaders, rightKeys, valuePairs) {
    const headers = ['reconcile_status', 'audit_match_by', 'audit_security_key', 'reconcile_key'];
    for (const h of leftHeaders || []) {
        if (!h || h.startsWith('_security_match')) continue;
        if (!headers.includes(h)) headers.push(h);
    }
    for (const col of rightKeys) {
        const bh = `broker_${col}`;
        if (!headers.includes(bh)) headers.push(bh);
    }
    for (const pair of valuePairs) {
        const bh = `broker_${pair.right}`;
        if (!headers.includes(bh)) headers.push(bh);
    }
    return headers;
}

function isEnrichLeftMode(plan = {}) {
    const join = String(plan.join || plan.reportMode || '').toLowerCase();
    return join === 'enrich_left' || join === 'audit_enrich';
}

function runEnrichLeftReconciliation(leftTable, rightTable, plan = {}) {
    const leftKeys = plan.leftKeys || [];
    const rightKeys = plan.rightKeys || plan.leftKeys || [];
    const normalizers = plan.normalizers || [];
    const dateFallback = plan.dateFallback !== false;
    const securityMatch = plan.securityMatch === true;
    const valuePairs = inferValuePairs(leftTable.headers, rightTable.headers, plan);

    const rightIndex = securityMatch
        ? buildSecurityRightIndex(rightTable.rows, plan)
        : buildRightIndex(rightTable.rows, rightKeys, normalizers, { dateFallback });

    const reportRows = [];
    let matched = 0;
    let onlyLeft = 0;
    let valueMismatch = 0;

    for (const leftRow of leftTable.rows || []) {
        let rightRow = null;
        let reconcileKey = '';
        let auditMatchBy = leftRow._security_match_by || '';

        if (securityMatch) {
            const hit = lookupSecurityRow(leftRow, rightIndex, plan);
            rightRow = hit.row;
            reconcileKey = hit.reconcileKey;
            if (rightRow) auditMatchBy = hit.auditMatchBy || leftRow._security_match_by || 'security';
        } else {
            reconcileKey = buildCompositeKey(leftRow, leftKeys, 'left', normalizers);
            rightRow = rightIndex.get(reconcileKey);
        }

        const base = {
            ...leftRow,
            reconcile_key: reconcileKey,
            audit_security_key: leftRow._security_key || '',
            audit_match_by: rightRow ? auditMatchBy : leftRow._security_match_by || '',
            reconcile_status: 'match',
            _reconcile_mismatch_columns: [],
            ...attachBrokerFields(rightRow, rightKeys, valuePairs),
        };

        let finalRow = base;
        if (securityMatch || plan.auditScenarioId) {
            if (!rightRow) {
                onlyLeft += 1;
                finalRow = {
                    ...base,
                    reconcile_status: 'only_left',
                    audit_match_by: '',
                    ...decorateAuditRow(
                        { ...base, reconcile_status: 'only_left', audit_match_by: '' },
                        { valuePairs }
                    ),
                };
            } else {
                const mismatchCols = compareValuePairs(leftRow, rightRow, valuePairs);
                if (mismatchCols.length) {
                    valueMismatch += 1;
                    finalRow = {
                        ...base,
                        reconcile_status: 'value_mismatch',
                        _reconcile_mismatch_columns: mismatchCols,
                        ...decorateAuditRow(
                            {
                                ...base,
                                reconcile_status: 'value_mismatch',
                                _reconcile_mismatch_columns: mismatchCols,
                            },
                            { valuePairs }
                        ),
                    };
                } else {
                    matched += 1;
                    finalRow = {
                        ...base,
                        ...decorateAuditRow({ ...base, reconcile_status: 'match' }, { valuePairs }),
                    };
                }
            }
        } else if (!rightRow) {
            onlyLeft += 1;
            finalRow = { ...base, reconcile_status: 'only_left', audit_match_by: '' };
        } else {
            const mismatchCols = compareValuePairs(leftRow, rightRow, valuePairs);
            if (mismatchCols.length) {
                valueMismatch += 1;
                finalRow = {
                    ...base,
                    reconcile_status: 'value_mismatch',
                    _reconcile_mismatch_columns: mismatchCols,
                };
            } else {
                matched += 1;
            }
        }
        reportRows.push(finalRow);
    }

    const headers =
        securityMatch || plan.auditScenarioId
            ? buildAuditEnrichHeaders(leftTable.headers, reportRows[0] || {})
            : buildEnrichLeftHeaders(leftTable.headers, rightKeys, valuePairs);

    return {
        ok: onlyLeft === 0 && valueMismatch === 0,
        headers,
        rows: reportRows,
        summary: {
            leftCount: (leftTable.rows || []).length,
            rightCount: (rightTable.rows || []).length,
            matched,
            only_left: onlyLeft,
            only_right: 0,
            value_mismatch: valueMismatch,
            leftKeys,
            rightKeys,
            valuePairs,
            reportMode: 'enrich_left',
            securityMatch,
            auditScenarioId: plan.auditScenarioId || null,
        },
    };
}

/**
 * @param {{ headers: string[], rows: object[] }} leftTable
 * @param {{ headers: string[], rows: object[] }} rightTable
 * @param {object} plan
 */
function runReconciliation(leftTable, rightTable, plan = {}) {
    if (isEnrichLeftMode(plan)) {
        return runEnrichLeftReconciliation(leftTable, rightTable, plan);
    }

    const leftKeys = plan.leftKeys || [];
    const rightKeys = plan.rightKeys || plan.leftKeys || [];
    const normalizers = plan.normalizers || [];
    const valuePairs = inferValuePairs(leftTable.headers, rightTable.headers, plan);
    const dateFallback = plan.dateFallback !== false;

    const rightIndex = buildRightIndex(rightTable.rows, rightKeys, normalizers, { dateFallback });

    const reportRows = [];
    let matched = 0;
    let onlyLeft = 0;
    let onlyRight = 0;
    let valueMismatch = 0;

    for (const leftRow of leftTable.rows || []) {
        const key = buildCompositeKey(leftRow, leftKeys, 'left', normalizers);
        const rightRow = rightIndex.get(key);
        const base = {
            reconcile_key: key,
            reconcile_status: 'match',
            _reconcile_mismatch_columns: [],
        };

        for (const col of leftKeys) {
            base[`left_${col}`] = leftRow[col] ?? '';
        }
        for (const pair of valuePairs) {
            base[`left_${pair.left}`] = leftRow[pair.left] ?? '';
        }

        if (!rightRow) {
            onlyLeft += 1;
            reportRows.push({
                ...base,
                reconcile_status: 'only_left',
            });
            continue;
        }
        rightIndex.delete(key);

        for (const col of rightKeys) {
            base[`right_${col}`] = rightRow[col] ?? '';
        }

        const mismatchCols = compareValuePairs(leftRow, rightRow, valuePairs);
        for (const pair of valuePairs) {
            base[`right_${pair.right}`] = rightRow[pair.right] ?? '';
        }

        if (mismatchCols.length) {
            valueMismatch += 1;
            reportRows.push({
                ...base,
                reconcile_status: 'value_mismatch',
                _reconcile_mismatch_columns: mismatchCols,
            });
        } else {
            matched += 1;
            reportRows.push(base);
        }
    }

    for (const [key, rightRow] of rightIndex.entries()) {
        onlyRight += 1;
        const base = {
            reconcile_key: key,
            reconcile_status: 'only_right',
            _reconcile_mismatch_columns: [],
        };
        for (const col of rightKeys) {
            base[`right_${col}`] = rightRow[col] ?? '';
        }
        for (const pair of valuePairs) {
            base[`right_${pair.right}`] = rightRow[pair.right] ?? '';
        }
        reportRows.push(base);
    }

    const headers = buildReportHeaders(leftKeys, rightKeys, valuePairs);

    return {
        ok: onlyLeft === 0 && onlyRight === 0 && valueMismatch === 0,
        headers,
        rows: reportRows,
        summary: {
            leftCount: (leftTable.rows || []).length,
            rightCount: (rightTable.rows || []).length,
            matched,
            only_left: onlyLeft,
            only_right: onlyRight,
            value_mismatch: valueMismatch,
            leftKeys,
            rightKeys,
            valuePairs,
        },
    };
}

function buildReportHeaders(leftKeys, rightKeys, valuePairs) {
    const headers = ['reconcile_status', 'reconcile_key'];
    for (const col of leftKeys) {
        const h = `left_${col}`;
        if (!headers.includes(h)) headers.push(h);
    }
    for (const pair of valuePairs) {
        const lh = `left_${pair.left}`;
        const rh = `right_${pair.right}`;
        if (!headers.includes(lh)) headers.push(lh);
        if (!headers.includes(rh)) headers.push(rh);
    }
    for (const col of rightKeys) {
        const h = `right_${col}`;
        if (!headers.includes(h)) headers.push(h);
    }
    return headers;
}

module.exports = {
    normalizeKey,
    normalizeSecurityName,
    normalizeNum,
    numsClose,
    runReconciliation,
    buildCompositeKey,
    inferValuePairs,
    buildReportHeaders,
    buildEnrichLeftHeaders,
    isEnrichLeftMode,
};
