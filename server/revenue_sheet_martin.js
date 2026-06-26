const { readSheetWithMeta } = require('./excel_sheet_meta');
const { detect01PeriodBlock } = require('./smart_parse_os');

const REVENUE_ACCOUNT_RE = /^9[01]\.\d+/;

function cellText(row, col) {
    return String((row && row[col]) ?? '').trim();
}

function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function rowHasAmounts(row, fromCol, toCol) {
    for (let c = fromCol; c <= toCol; c++) {
        const n = toNum(row[c]);
        if (n !== null && n !== 0) return true;
    }
    return false;
}

function readEntityFromHeader(data) {
    for (const row of data.slice(0, 12)) {
        const t0 = cellText(row, 0);
        const t1 = cellText(row, 1);
        if (/^ОАО|^ООО|^АО|^ПАО|^ЗАО/i.test(t0)) return t0;
        if (/^ОАО|^ООО|^АО|^ПАО|^ЗАО/i.test(t1)) return t1;
    }
    return '';
}

function findPeriodHeaderRows(data) {
    let periodRow = -1;
    for (let i = 0; i < Math.min(data.length, 25); i++) {
        const line = (data[i] || []).map((c) => String(c || '')).join(' ');
        if (/На начало периода/i.test(line)) {
            periodRow = i;
            break;
        }
    }
    if (periodRow < 0) return null;

    const headerRows = [periodRow];
    const next = data[periodRow + 1] || [];
    const nextText = next.map((c) => String(c || '').toLowerCase()).join(' ');
    if (
        /стоимост|амортизац|оборот|сальдо|дебет|кредит|дт|кт/i.test(nextText) &&
        next.some((c) => String(c || '').trim())
    ) {
        headerRows.push(periodRow + 1);
    }
    return { headerRows, dataStartRow: Math.max(...headerRows) + 1 };
}

function buildPeriodBands(row, maxCol) {
    const bands = [];
    let current = '';
    for (let c = 0; c <= maxCol; c++) {
        const t = cellText(row, c);
        if (t) current = t;
        bands[c] = current;
    }
    return bands;
}

function buildColumnTitles(data, headerRows) {
    const maxCol = Math.max(...data.slice(0, 30).map((r) => r.length), 8);
    const periodBands = buildPeriodBands(data[headerRows[0]] || [], maxCol);
    const titles = [];
    for (let col = 1; col <= maxCol; col++) {
        const parts = [];
        if (periodBands[col]) parts.push(periodBands[col]);
        for (let hi = 1; hi < headerRows.length; hi++) {
            const t = cellText(data[headerRows[hi]], col);
            if (t && !parts.includes(t)) parts.push(t);
        }
        if (!parts.length) {
            const t = cellText(data[headerRows[0]], col);
            if (t) parts.push(t);
        }
        if (!parts.length) continue;
        titles.push({ col, title: parts.join(' / ') });
    }
    return titles;
}

function detectRevenueOsvTurnoverBlock(data) {
    return Boolean(findRevenueOsvBlock(data));
}

function findRevenueOsvBlock(data) {
    let titleRow = -1;
    for (let i = 0; i < data.length; i++) {
        const line = (data[i] || []).map((c) => String(c || '')).join(' ');
        if (/оборотно-сальдовая\s+ведомость\s+по\s+счету\s+9[01]/i.test(line)) {
            titleRow = i;
            break;
        }
    }
    if (titleRow < 0) {
        for (let i = 0; i < Math.min(data.length, 40); i++) {
            const row = data[i] || [];
            const joined = row.map((c) => String(c || '').toLowerCase()).join(' ');
            if (/номенклатурн/.test(joined) && /дебет/.test(joined) && /кредит/.test(joined)) {
                titleRow = Math.max(0, i - 2);
                break;
            }
        }
    }
    if (titleRow < 0) return null;

    let dataStartRow = titleRow + 1;
    let debitCol = 2;
    let creditCol = 3;
    const indicatorCol = 1;
    const nameCol = 0;

    for (let i = titleRow + 1; i < Math.min(data.length, titleRow + 8); i++) {
        const row = data[i] || [];
        for (let c = 0; c < row.length; c++) {
            const t = cellText(row, c).toLowerCase();
            if (t.includes('дебет')) debitCol = c;
            if (t.includes('кредит')) creditCol = c;
        }
        if (/^период$/i.test(cellText(row, nameCol))) {
            dataStartRow = i + 1;
            break;
        }
    }

    const entitySlice = data.slice(Math.max(0, titleRow - 6), titleRow + 1);
    return {
        titleRow,
        dataStartRow,
        entity: readEntityFromHeader(entitySlice),
        debitCol,
        creditCol,
        indicatorCol,
        nameCol,
    };
}

function normalizeIndicator(text) {
    const t = String(text || '').trim().toLowerCase().replace(/\./g, '');
    if (t.startsWith('кол')) return 'Кол.';
    if (t === 'бу' || t.startsWith('бух')) return 'БУ';
    return '';
}

function isRevenueHeaderLabel(name) {
    const t = String(name || '').trim().toLowerCase();
    return (
        !t ||
        /^счет[,.\s]|наименование счета/i.test(t) ||
        /^номенклатурн/i.test(t) ||
        /^период$/i.test(t) ||
        /^показател/i.test(t) ||
        /^дебет$/i.test(t) ||
        /^кредит$/i.test(t)
    );
}

function materializeRevenueOsvRecord(record, entity) {
    const fmt = (n) => (n === null || n === undefined ? '' : n);
    let level = 'счёт';
    if (record.group && record.period) level = 'период';
    else if (record.group) level = 'группа';
    else if (record.period) level = 'сводка периода';

    return {
        Юрлицо: entity,
        Счёт: record.account,
        'Номенклатурная группа': record.group,
        Период: record.period,
        Уровень: level,
        'Дебет БУ': fmt(record.bu?.debit),
        'Кредит БУ': fmt(record.bu?.credit),
        'Дебет Кол.': fmt(record.kol?.debit),
        'Кредит Кол.': fmt(record.kol?.credit),
    };
}

function parseRevenueOsvTurnoverBlock(data) {
    const block = findRevenueOsvBlock(data);
    if (!block) return null;

    const headers = [
        'Юрлицо',
        'Счёт',
        'Номенклатурная группа',
        'Период',
        'Уровень',
        'Дебет БУ',
        'Кредит БУ',
        'Дебет Кол.',
        'Кредит Кол.',
    ];
    const rows = [];

    let currentAccount = '';
    let currentGroup = '';
    let currentPeriod = '';
    let currentRecord = null;

    const contextKey = () => `${currentAccount}\0${currentGroup}\0${currentPeriod}`;

    const flushRecord = () => {
        if (!currentRecord) return;
        if (!currentRecord.bu && !currentRecord.kol) {
            currentRecord = null;
            return;
        }
        rows.push(materializeRevenueOsvRecord(currentRecord, block.entity));
        currentRecord = null;
    };

    const ensureRecord = () => {
        const key = contextKey();
        if (!currentRecord || currentRecord.key !== key) {
            flushRecord();
            currentRecord = {
                key,
                account: currentAccount,
                group: currentGroup,
                period: currentPeriod,
                bu: null,
                kol: null,
            };
        }
    };

    for (let i = block.dataStartRow; i < data.length; i++) {
        const row = data[i] || [];
        const name = cellText(row, block.nameCol);
        const indicator = normalizeIndicator(cellText(row, block.indicatorCol));
        if (!name && !indicator) continue;
        if (/^итого/i.test(name)) break;
        if (/^<\.\.\.>/i.test(name)) continue;

        if (name && !isRevenueHeaderLabel(name)) {
            if (isRevenueAccountLabel(name)) {
                if (currentAccount !== name) {
                    flushRecord();
                    currentAccount = name;
                    currentGroup = '';
                    currentPeriod = '';
                }
            } else if (/^обороты за/i.test(name)) {
                if (currentPeriod !== name) {
                    flushRecord();
                    currentPeriod = name;
                }
            } else {
                if (currentGroup !== name) {
                    flushRecord();
                    currentGroup = name;
                    currentPeriod = '';
                }
            }
        }

        if (!indicator) continue;

        const debit = toNum(row[block.debitCol]);
        const credit = toNum(row[block.creditCol]);
        if (debit === null && credit === null) continue;

        ensureRecord();
        const amounts = { debit, credit };
        if (indicator === 'БУ') currentRecord.bu = amounts;
        if (indicator === 'Кол.') currentRecord.kol = amounts;
    }

    flushRecord();

    if (!rows.length) return null;
    return { headers, rows, scenarioId: 'revenue_osv_90' };
}

function isRevenueSheetContext(fileName, sheetName, data) {
    const rows = data || [];
    const { classifySheetStructure } = require('./structure_classifier');
    const structure = classifySheetStructure(rows, {});
    if (structure.structure_id === 'revenue_osv_90' && structure.autoParse) return true;

    const has90 = rows.some((row) => REVENUE_ACCOUNT_RE.test(cellText(row, 0)));
    const hasPeriodBlock = detect01PeriodBlock(rows) || detectRevenueOsvTurnoverBlock(rows);
    const titleHint = rows
        .slice(0, 20)
        .some((row) => /оборотно-сальдовая\s+ведомость\s+по\s+счету\s+9/i.test((row || []).join(' ')));
    return titleHint && has90 && hasPeriodBlock;
}

function isRevenueAccountLabel(text) {
    const t = String(text || '').trim();
    if (!REVENUE_ACCOUNT_RE.test(t)) return false;
    if (/выруч|доход|реализац/i.test(t)) return true;
    return REVENUE_ACCOUNT_RE.test(t);
}

function parseRevenuePeriodBlock(data) {
    if (!detect01PeriodBlock(data)) return null;
    const block = findPeriodHeaderRows(data);
    if (!block) return null;

    const entity = readEntityFromHeader(data);
    const colTitles = buildColumnTitles(data, block.headerRows);
    if (!colTitles.length) return null;

    const headers = ['Юрлицо', 'Счёт', ...colTitles.map((c) => c.title)];
    const rows = [];

    for (let i = block.dataStartRow; i < data.length; i++) {
        const row = data[i] || [];
        const account = cellText(row, 0);
        if (!account || /^Итого/i.test(account)) continue;
        if (!isRevenueAccountLabel(account)) continue;
        if (!rowHasAmounts(row, 1, Math.max(...colTitles.map((c) => c.col), 1))) continue;

        const out = { Юрлицо: entity, Счёт: account };
        for (const { col, title } of colTitles) {
            const n = toNum(row[col]);
            out[title] = n == null ? '' : n;
        }
        rows.push(out);
    }

    if (!rows.length) return null;
    return { headers, rows, scenarioId: 'revenue_period' };
}

function loadSheetRows(buffer, sheetName) {
    const loaded = readSheetWithMeta(buffer, sheetName, { useExcelProbe: true });
    return loaded.data || [];
}

function parseRevenueSheet(buffer, sheetName, fileName = '') {
    const data = loadSheetRows(buffer, sheetName);
    if (!data.length) return null;
    if (!isRevenueSheetContext(fileName, sheetName, data)) return null;
    const osv = parseRevenueOsvTurnoverBlock(data);
    if (osv?.rows?.length) return osv;
    return parseRevenuePeriodBlock(data);
}

async function importRevenueParseToSnapshot(pool, { file, sheetName, projectId, parsed }) {
    const { createParseSnapshotStore } = require('./parse_snapshot_store');
    const store = createParseSnapshotStore(pool);
    const sid = await store.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: file.originalname,
        sheetName,
        scenarioId: parsed.scenarioId,
        headers: parsed.headers,
        status: 'parsing',
    });
    const rowCount = await store.importParsedRows(sid, parsed.headers, parsed.rows);
    const previewRows = parsed.rows.slice(0, 200);
    return {
        ok: true,
        snapshotId: sid,
        parsePreview: { ok: true, headers: parsed.headers, rows: previewRows, rowCount },
        warnings: [],
    };
}

async function tryParseRevenueSheet({ pool, file, sheetName, projectId }) {
    const parsed = parseRevenueSheet(file.buffer, sheetName, file.originalname || '');
    if (!parsed?.rows?.length) return null;

    const imported = await importRevenueParseToSnapshot(pool, { file, sheetName, projectId, parsed });
    if (!imported.ok) return null;

    return {
        ok: true,
        sheetName,
        scenarioId: parsed.scenarioId,
        scenarioName: 'Выручка (счёт 90)',
        snapshotId: imported.snapshotId,
        rowCount: imported.parsePreview.rowCount,
        parsePreview: imported.parsePreview,
        warnings: imported.warnings,
    };
}

function detectRevenueScore(ctx) {
    const data = ctx.data || [];
    const structure = ctx.structure;
    if (structure?.structure_id === 'revenue_osv_90' && structure.autoParse) {
        const parsed = parseRevenuePeriodBlock(data) || parseRevenueOsvTurnoverBlock(data);
        return parsed?.rows?.length ? Math.max(structure.confidence, 0.96) : structure.confidence * 0.9;
    }
    if (!isRevenueSheetContext(ctx.file?.originalname, ctx.sheetName, data)) return 0;
    const parsed = parseRevenuePeriodBlock(data) || parseRevenueOsvTurnoverBlock(data);
    return parsed?.rows?.length ? 0.96 : 0;
}

module.exports = {
    REVENUE_ACCOUNT_RE,
    isRevenueSheetContext,
    isRevenueAccountLabel,
    detectRevenueOsvTurnoverBlock,
    findRevenueOsvBlock,
    parseRevenuePeriodBlock,
    parseRevenueOsvTurnoverBlock,
    parseRevenueSheet,
    tryParseRevenueSheet,
    detectRevenueScore,
};
