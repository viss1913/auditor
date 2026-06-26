/**
 * Структурный отпечаток листа Excel — выбор профиля по форме данных,
 * а не по точным названиям колонок.
 */

const UK_DATE_RE = /^\d{2}\.\d{2}\.\d{4}/;
const YEAR_METRIC_RE = /^\d{4}\s*-\s*(начало|амортизация|конец|стоимость|оборот)/i;
const ACCOUNT_GL_RE = /^(\d{2}\.)+\d+/;
const ACCOUNT_90_RE = /^9[01]\.\d+/;
const ACCOUNT_76_RE = /^76(\.|,|\s)/;
const ACCOUNT_08_RE = /^08(\.|$)/;
const OS_INVENTORY_RE = /80-\d+|инв\.?\s*№|^\d{6,}.*\d{2}\.\d{2}\.\d{4}/i;

/** Заголовок отчёта в первых строках — важнее имени листа «08» / «01». */
function detectReportTitleKind(data) {
    const blob = (data || [])
        .slice(0, 20)
        .flat()
        .map((c) => String(c ?? ''))
        .join(' ');
    if (/оборотно[\s-]*сальдовая\s+ведомость\s+по\s+счет[уё]\s*0?8/i.test(blob)) return 'osv_08';
    if (/ведомость\s+амортизации\s+ос/i.test(blob)) return 'os_01';
    return null;
}

function cellText(row, col) {
    return String((row && row[col]) ?? '').trim();
}

function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    if (!/^-?\d/.test(s)) return null;
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function rowHasNumbers(row, fromCol = 1) {
    for (let c = fromCol; c < (row || []).length; c++) {
        if (toNum(row[c]) != null) return true;
    }
    return false;
}

function scanCol0(data, limit = 120) {
    const stats = {
        dateRows: 0,
        account90: 0,
        account76: 0,
        account08: 0,
        accountOther: 0,
        contractLabels: 0,
        counterpartyLabels: 0,
        osInventoryLike: 0,
        longTextWithNumbers: 0,
        shortGroupLabels: 0,
    };

    for (let i = 0; i < Math.min(data.length, limit); i++) {
        const label = cellText(data[i], 0);
        if (!label) continue;
        if (UK_DATE_RE.test(label)) stats.dateRows++;
        if (ACCOUNT_90_RE.test(label)) stats.account90++;
        else if (ACCOUNT_76_RE.test(label)) stats.account76++;
        else if (ACCOUNT_08_RE.test(label)) stats.account08++;
        else if (ACCOUNT_GL_RE.test(label)) stats.accountOther++;
        if (/^Договор\s/i.test(label)) stats.contractLabels++;
        if (/^Контрагент/i.test(label)) stats.counterpartyLabels++;
        if (OS_INVENTORY_RE.test(label)) stats.osInventoryLike++;
        if (label.length >= 18 && rowHasNumbers(data[i], 1)) stats.longTextWithNumbers++;
        if (label.length >= 3 && label.length < 48 && !rowHasNumbers(data[i], 1) && !ACCOUNT_GL_RE.test(label)) {
            stats.shortGroupLabels++;
        }
    }
    return stats;
}

function detectPeriodBandRow(data) {
    for (let i = 0; i < Math.min(data.length, 25); i++) {
        const row = data[i] || [];
        let textBands = 0;
        for (let c = 1; c < Math.min(row.length, 14); c++) {
            const t = cellText(row, c);
            if (!t || toNum(t) != null) continue;
            if (t.length >= 3 && t.length <= 48) textBands++;
        }
        if (textBands < 2) continue;

        const next = data[i + 1] || [];
        let metricCells = 0;
        for (let c = 1; c < Math.min(next.length, 14); c++) {
            const t = cellText(next, c).toLowerCase();
            if (!t || toNum(next[c]) != null) continue;
            if (t.length > 0 && t.length <= 24) metricCells++;
        }
        if (metricCells >= 2) return i;

        if (/На начало периода|Группа учета/i.test(row.join(' '))) return i;
    }
    return -1;
}

function detectWideYearHeaderRow(data) {
    for (let i = 0; i < Math.min(data.length, 25); i++) {
        const labels = (data[i] || []).map((c) => String(c || '').trim());
        const yearCols = labels.filter((l) => YEAR_METRIC_RE.test(l));
        if (yearCols.length >= 3) return i;
    }
    return -1;
}

function detectFlatDimensionHeaderRow(data) {
    for (let i = 0; i < Math.min(data.length, 22); i++) {
        const row = data[i] || [];
        const textCols = [];
        for (let c = 0; c < Math.min(row.length, 12); c++) {
            const t = cellText(row, c);
            if (t && t.length >= 2 && toNum(row[c]) == null && !UK_DATE_RE.test(t)) {
                textCols.push(c);
            }
        }
        if (textCols.length < 4) continue;

        let dataRows = 0;
        for (let r = i + 1; r < Math.min(i + 8, data.length); r++) {
            const dr = data[r] || [];
            const filled = textCols.filter((c) => cellText(dr, c)).length;
            const hasNums = rowHasNumbers(dr, Math.max(...textCols) + 1);
            if (filled >= 3 && (hasNums || textCols.every((c) => cellText(dr, c)))) dataRows++;
        }
        if (dataRows >= 2) return { headerRow: i, dimCols: textCols.length };
    }
    return null;
}

function detectUkStructure(data) {
    let dateRows = 0;
    let bu58 = 0;
    let kolRows = 0;
    const scanEnd = Math.min(data.length, 400);

    for (let i = 7; i < scanEnd; i++) {
        const row = data[i];
        if (!row) continue;
        if (UK_DATE_RE.test(cellText(row, 0))) dateRows++;
        for (let c = 4; c <= 8; c++) {
            const indicator = cellText(row, c);
            const account = cellText(row, c + 1);
            if (indicator === 'БУ' && /^58\.0?1/.test(account)) bu58++;
            if (indicator === 'Кол.') kolRows++;
        }
    }

    const structureMatch = bu58 >= 2 && dateRows >= 3;
    return { dateRows, bu58, kolRows, structureMatch, score: structureMatch ? 0.94 : bu58 >= 1 && dateRows >= 2 ? 0.75 : 0 };
}

function detectKsStructure(data) {
    let headerRow = -1;
    for (let i = 0; i < Math.min(25, data.length); i++) {
        const lower = (data[i] || []).map((c) => String(c || '').toLowerCase());
        const hasPeriod = lower.some((t) => t.includes('период'));
        const hasParty = lower.some((t) => t.includes('контрагент') || t.includes('документ'));
        if (hasPeriod && hasParty) {
            headerRow = i;
            break;
        }
    }
    if (headerRow < 0) {
        let dateRows = 0;
        for (let i = 0; i < Math.min(data.length, 80); i++) {
            if (UK_DATE_RE.test(cellText(data[i], 0)) && rowHasNumbers(data[i], 3)) dateRows++;
        }
        if (dateRows >= 3) return { headerRow: -1, dateRows, score: 0.72 };
        return { headerRow: -1, dateRows: 0, score: 0 };
    }

    let dateRows = 0;
    for (let i = headerRow + 1; i < Math.min(data.length, headerRow + 120); i++) {
        if (UK_DATE_RE.test(cellText(data[i], 0))) dateRows++;
    }
    return { headerRow, dateRows, score: dateRows >= 2 ? 0.88 : 0.55 };
}

function buildLayoutFingerprint(data, options = {}) {
    const col0 = scanCol0(data);
    const periodBandRow = detectPeriodBandRow(data);
    const wideYearRow = detectWideYearHeaderRow(data);
    const flatDim = detectFlatDimensionHeaderRow(data);
    const uk = detectUkStructure(data);
    const ks = detectKsStructure(data);

    const hierarchyLike =
        data.slice(0, 40).filter((r) => cellText(r, 0) && rowHasNumbers(r, 1)).length;
    const hasOutline = Boolean(options.hasOutline);
    const outlineDepth = (options.rowOutlineLevels || []).reduce((m, v) => Math.max(m, v || 0), 0);

    return {
        rowCount: data.length,
        col0,
        periodBandRow,
        wideYearRow,
        flatDim,
        uk,
        ks,
        hierarchyLike,
        hasOutline,
        outlineDepth,
        reportTitleKind: detectReportTitleKind(data),
        sheetName: options.sheetName || '',
        fileName: options.fileName || '',
    };
}

function textHintBoost(hints, profileHint) {
    let boost = 0;
    const blob = `${hints.fileName || ''} ${hints.sheetName || ''}`.toLowerCase();
    const titleKind = hints.reportTitleKind || null;
    const map = {
        uk_card: /карт|58[.,]\s*0?1|ук\b|ценн|бумаг/,
        ks_card: /\bкс\b|исходн.*кс|обработан.*кс/,
        revenue_period: /выруч|рд_|кэсел|кесел/,
        os_osv_08: /\b08\b|осв/,
        os_depreciation_01: /\b01\b|амортизац/,
        os_account_card_76: /\b76\b|карточк/,
    };
    if (profileHint === 'os_osv_08') {
        if (titleKind === 'os_01') return -0.12;
        if (titleKind !== 'osv_08' && (hints.col0?.account08 || 0) === 0) return 0;
    }
    if (profileHint === 'os_depreciation_01' && titleKind === 'os_01') boost += 0.08;
    if (map[profileHint]?.test(blob)) boost += 0.06;
    return boost;
}

/**
 * @returns {Array<{ layout_type, profile_hint, confidence, description, fingerprint_reason }>}
 */
function scoreProfileCandidates(fingerprint) {
    const { col0, periodBandRow, wideYearRow, flatDim, uk, ks, hierarchyLike, hasOutline, reportTitleKind } =
        fingerprint;
    const candidates = [];

    const push = (entry) => {
        candidates.push({
            ...entry,
            confidence: Math.min(0.99, entry.confidence),
        });
    };

    if (uk.score >= 0.88) {
        push({
            layout_type: 'fixed_columns',
            profile_hint: 'uk_card',
            confidence: uk.score,
            description: 'Карточка счёта: даты в col A, БУ/Кол. в строках',
            fingerprint_reason: `uk dates=${uk.dateRows} bu58=${uk.bu58}`,
        });
    }

    if (ks.score >= 0.7) {
        push({
            layout_type: 'fixed_columns',
            profile_hint: 'ks_card',
            confidence: ks.score,
            description: 'Карточка счёта (КС): шапка + строки с датами',
            fingerprint_reason: `ks headerRow=${ks.headerRow} dates=${ks.dateRows}`,
        });
    }

    const has76Tree =
        col0.contractLabels > 0 && col0.counterpartyLabels > 0 && (col0.account76 > 0 || col0.accountOther > 0);
    if (has76Tree) {
        push({
            layout_type: 'hierarchy_osv',
            profile_hint: 'os_account_card_76',
            confidence: 0.94,
            description: 'Иерархия счёт 76: договор + контрагент в col A',
            fingerprint_reason: `contract=${col0.contractLabels} counterparty=${col0.counterpartyLabels}`,
        });
    }

    if (col0.account08 > 0 && !has76Tree) {
        push({
            layout_type: 'hierarchy_osv',
            profile_hint: 'os_osv_08',
            confidence: reportTitleKind === 'osv_08' ? 0.94 : 0.9,
            description: 'ОСВ 08: счёт 08 в col A',
            fingerprint_reason: `account08=${col0.account08}`,
        });
    }

    if (wideYearRow >= 0) {
        push({
            layout_type: 'wide_metrics',
            profile_hint: 'os_wide_years',
            confidence: 0.86,
            description: 'Годы в шапке колонок',
            fingerprint_reason: `wideHeaderRow=${wideYearRow}`,
        });
    }

    const revenueStruct =
        periodBandRow >= 0 && col0.account90 > 0 && col0.osInventoryLike === 0 && col0.contractLabels === 0;
    if (revenueStruct) {
        push({
            layout_type: 'fixed_columns',
            profile_hint: 'revenue_period',
            confidence: 0.93,
            description: 'Счета 90/91 + периоды в шапке (не ОС)',
            fingerprint_reason: `account90=${col0.account90} periodBand=${periodBandRow}`,
        });
    }

    if (flatDim && flatDim.dimCols >= 4 && !has76Tree) {
        push({
            layout_type: 'fixed_columns',
            profile_hint: 'osv_flat_processed',
            confidence: 0.84,
            description: 'Плоская таблица: несколько измерений + числа',
            fingerprint_reason: `flatHeader=${flatDim.headerRow} dims=${flatDim.dimCols}`,
        });
    }

    const os01Struct =
        periodBandRow >= 0 &&
        !revenueStruct &&
        col0.account08 === 0 &&
        reportTitleKind !== 'osv_08' &&
        (col0.osInventoryLike > 0 || col0.longTextWithNumbers >= 2 || hasOutline || hierarchyLike >= 5);
    if (os01Struct) {
        push({
            layout_type: 'hierarchy_rows',
            profile_hint: 'os_depreciation_01',
            confidence: hasOutline || col0.osInventoryLike > 0 ? 0.9 : 0.78,
            description: 'Ведомость ОС: периоды в шапке + иерархия/ОС в col A',
            fingerprint_reason: `inventory=${col0.osInventoryLike} outline=${hasOutline} hierarchy=${hierarchyLike}`,
        });
    }

    if (hierarchyLike >= 5 && !candidates.some((c) => c.profile_hint === 'os_depreciation_01')) {
        push({
            layout_type: 'hierarchy_rows',
            profile_hint: 'unknown_hierarchy',
            confidence: 0.52,
            description: 'Иерархия в col A + числа справа',
            fingerprint_reason: `hierarchyLike=${hierarchyLike}`,
        });
    }

    if (!candidates.length) {
        push({
            layout_type: 'fixed_columns',
            profile_hint: 'unknown_table',
            confidence: 0.42,
            description: 'Табличный формат (низкая уверенность)',
            fingerprint_reason: 'fallback',
        });
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    return candidates;
}

module.exports = {
    buildLayoutFingerprint,
    scoreProfileCandidates,
    scanCol0,
    detectReportTitleKind,
    detectPeriodBandRow,
    detectWideYearHeaderRow,
    detectFlatDimensionHeaderRow,
    detectUkStructure,
    detectKsStructure,
    UK_DATE_RE,
    ACCOUNT_90_RE,
};
