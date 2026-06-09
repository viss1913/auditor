const xlsx = require('xlsx');

function normalizeKey(val) {
    return String(val ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
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

/**
 * Загрузить эталон из Excel (первый лист или mapping) или JSON rows.
 */
function loadTargetRows(buffer, options = {}) {
    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const sheetName =
        options.sheetName ||
        workbook.SheetNames.find((s) => /мэппинг|mapping|эталон|target/i.test(s)) ||
        workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!aoa.length) return { headers: [], rows: [] };

    let headerRowIndex = 0;
    for (let i = 0; i < Math.min(aoa.length, 5); i++) {
        if (aoa[i].filter((c) => String(c).trim()).length >= 2) {
            headerRowIndex = i;
            break;
        }
    }

    const headers = aoa[headerRowIndex].map((h) => String(h || '').trim());
    const rows = aoa.slice(headerRowIndex + 1).map((row) => {
        const o = {};
        headers.forEach((h, i) => {
            if (h) o[h] = row[i] ?? '';
        });
        return o;
    }).filter((r) => Object.values(r).some((v) => String(v).trim()));

    return { headers, rows, sheetName };
}

/**
 * Сравнить превью парсера с эталоном.
 * @param {{ headers: string[], rows: object[] }} preview
 * @param {{ headers: string[], rows: object[] }} target
 * @param {{ keyColumns?: string[] }} opts
 */
function comparePreviewToTarget(preview, target, opts = {}) {
    const keyCols =
        opts.keyColumns ||
        [
            'ОС',
            'тип',
            'Тип',
            'Объект',
            'name',
            'Название ОС',
            'regNum',
            'Наименование',
        ].filter((k) => preview.headers?.includes(k) || target.headers?.includes(k));

    const effectiveKeys = keyCols.length
        ? keyCols
        : [preview.headers?.[3] || preview.headers?.[0]].filter(Boolean);

    const valueCols = (preview.headers || []).filter(
        (h) =>
            h &&
            !effectiveKeys.includes(h) &&
            (target.headers || []).includes(h) &&
            !/^Юрлицо|Группа|Подразделение|Счёт$/i.test(h)
    );

    const targetByKey = new Map();
    for (const row of target.rows || []) {
        const key = effectiveKeys.map((k) => normalizeKey(row[k])).join('|');
        if (key.replace(/\|/g, '')) targetByKey.set(key, row);
    }

    const mismatches = [];
    let matched = 0;
    let missingInTarget = 0;
    let missingInPreview = 0;

    for (const prow of preview.rows || []) {
        const key = effectiveKeys.map((k) => normalizeKey(prow[k])).join('|');
        const trow = targetByKey.get(key);
        if (!trow) {
            missingInTarget++;
            if (missingInTarget <= 20) {
                mismatches.push({
                    type: 'missing_in_target',
                    key,
                    previewRow: prow,
                });
            }
            continue;
        }
        targetByKey.delete(key);

        const colDiffs = [];
        for (const col of valueCols) {
            if (!numsClose(prow[col], trow[col])) {
                colDiffs.push({
                    column: col,
                    preview: prow[col],
                    target: trow[col],
                });
            }
        }
        if (colDiffs.length) {
            mismatches.push({ type: 'value_mismatch', key, diffs: colDiffs, previewRow: prow, targetRow: trow });
        } else {
            matched++;
        }
    }

    missingInPreview = targetByKey.size;
    for (const [key, trow] of [...targetByKey.entries()].slice(0, 20)) {
        mismatches.push({ type: 'missing_in_preview', key, targetRow: trow });
    }

    const previewCount = (preview.rows || []).length;
    const targetCount = (target.rows || []).length;

    return {
        ok: mismatches.length === 0 && previewCount === targetCount,
        summary: {
            previewCount,
            targetCount,
            matched,
            missingInTarget,
            missingInPreview,
            mismatchCount: mismatches.length,
            keyColumns: effectiveKeys,
            comparedValueColumns: valueCols,
        },
        mismatches: mismatches.slice(0, 50),
    };
}

module.exports = {
    loadTargetRows,
    comparePreviewToTarget,
};
