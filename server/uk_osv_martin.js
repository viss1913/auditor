const { readSheetWithMeta } = require('./excel_sheet_meta');
const { inferTableMeta } = require('./table_meta');

const UK_OSV_58_TITLE_RE = /оборотно-сальдовая\s+ведомость\s+по\s+счету\s+58/i;
const UK_ACCOUNT_58_RE = /^58\.0?1/;

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

function rowHasAmounts(row, cols) {
    for (const { col } of cols) {
        const n = toNum(row[col]);
        if (n !== null && n !== 0) return true;
    }
    return false;
}

function normalizeIndicator(text) {
    const t = String(text || '')
        .trim()
        .toLowerCase()
        .replace(/\./g, '');
    if (t.startsWith('кол')) return 'Кол.';
    if (t === 'бу' || t.startsWith('бух')) return 'БУ';
    return '';
}

function readFundFromHeader(data) {
    for (const row of data.slice(0, 6)) {
        const t = cellText(row, 0);
        if (t && t.length >= 3 && t.length <= 32 && !/оборотно|отбор|счет/i.test(t)) return t;
    }
    return '';
}

function readAccountFromTitle(data) {
    for (const row of data.slice(0, 8)) {
        const line = (row || []).join(' ');
        const m = line.match(/счет[уа]?\s+(\d{2}\.\d{2}(?:\.\d+)?)/i);
        if (m) return m[1];
    }
    return '';
}

function normalizeSideLabel(text) {
    const t = String(text || '')
        .trim()
        .toLowerCase();
    if (/^дт|дебет/.test(t)) return 'Дебет';
    if (/^кт|кредит/.test(t)) return 'Кредит';
    return '';
}

function forwardFillBands(row, fromCol, toCol) {
    const bands = [];
    let current = '';
    for (let c = fromCol; c <= toCol; c++) {
        const t = cellText(row, c);
        if (t && !/^показател/i.test(t)) current = t;
        bands[c] = current;
    }
    return bands;
}

function pickSubHeaderRow(data, bandRow, indicatorCol) {
    let bestRow = bandRow + 1;
    let bestScore = -1;
    for (let r = bandRow + 1; r <= Math.min(bandRow + 3, data.length - 1); r++) {
        const row = data[r] || [];
        let score = 0;
        for (let c = indicatorCol + 1; c < row.length; c++) {
            if (normalizeSideLabel(cellText(row, c))) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestRow = r;
        }
    }
    return bestRow;
}

function columnValues(data, col, fromRow, toRow = data.length) {
    const vals = [];
    for (let i = fromRow; i < Math.min(toRow, data.length); i++) {
        vals.push(toNum((data[i] || [])[col]));
    }
    return vals;
}

function columnsMirror(leftVals, rightVals) {
    if (leftVals.length !== rightVals.length) return false;
    let compared = 0;
    for (let i = 0; i < leftVals.length; i++) {
        const a = leftVals[i];
        const b = rightVals[i];
        if (a == null && b == null) continue;
        if (a == null || b == null) return false;
        compared++;
        if (Math.abs(a - b) > 1e-9) return false;
    }
    return compared > 0 || leftVals.some((v) => v != null);
}

function dedupeValueCols(valueCols, data, dataStartRow) {
    if (valueCols.length < 2) return valueCols;

    const kept = [];
    for (const colDef of valueCols) {
        const prev = kept[kept.length - 1];
        if (!prev) {
            kept.push(colDef);
            continue;
        }

        const sameTitle = prev.title === colDef.title;
        const mirror = columnsMirror(
            columnValues(data, prev.col, dataStartRow),
            columnValues(data, colDef.col, dataStartRow)
        );
        if (sameTitle || mirror) continue;
        kept.push(colDef);
    }
    return kept;
}

function buildValueCols(data, bandRow, indicatorCol, dataStartRow) {
    const subHeaderRow = pickSubHeaderRow(data, bandRow, indicatorCol);
    const maxCol = Math.max(
        (data[bandRow] || []).length,
        (data[subHeaderRow] || []).length,
        indicatorCol + 6
    );
    const bands = forwardFillBands(data[bandRow] || [], indicatorCol + 1, maxCol - 1);
    const valueCols = [];

    for (let c = indicatorCol + 1; c < maxCol; c++) {
        const period = bands[c] || '';
        const side = normalizeSideLabel(cellText(data[subHeaderRow], c));
        if (!period || !side) continue;
        valueCols.push({
            col: c,
            title: `${period} / ${side}`,
            period,
            side,
        });
    }

    return dedupeValueCols(valueCols, data, dataStartRow);
}

function buildMeasureHeaders(valueCols) {
    const headers = [];
    for (const vc of valueCols) {
        headers.push(`${vc.period} / ${vc.side} / БУ`);
        headers.push(`${vc.period} / ${vc.side} / Кол.`);
    }
    return headers;
}

function materializeUkOsvRecord(record, fund, valueCols, measureHeaders) {
    const out = {
        Фонд: fund,
        Счёт: record.account,
        Наименование: record.name,
        Валюта: record.currency || '',
    };
    for (const h of measureHeaders) out[h] = '';
    if (record.buRow) {
        for (const vc of valueCols) {
            const n = toNum(record.buRow[vc.col]);
            out[`${vc.period} / ${vc.side} / БУ`] = n === null ? '' : n;
        }
    }
    if (record.kolRow) {
        for (const vc of valueCols) {
            const n = toNum(record.kolRow[vc.col]);
            out[`${vc.period} / ${vc.side} / Кол.`] = n === null ? '' : n;
        }
    }
    return out;
}

function findUkOsv58Header(data) {
    let indicatorCol = -1;
    let bandRow = -1;

    for (let i = 0; i < Math.min(data.length, 30); i++) {
        const row = data[i] || [];
        for (let c = 0; c < row.length; c++) {
            if (/^показател/i.test(cellText(row, c))) {
                indicatorCol = c;
                bandRow = i;
                break;
            }
        }
        if (indicatorCol >= 0) break;
    }
    if (indicatorCol < 0 || bandRow < 0) return null;

    const subHeaderRow = pickSubHeaderRow(data, bandRow, indicatorCol);

    let dataStartRow = subHeaderRow + 1;
    while (dataStartRow < data.length) {
        const indicator = normalizeIndicator(cellText(data[dataStartRow], indicatorCol));
        if (indicator) break;
        dataStartRow++;
    }
    if (dataStartRow >= data.length) return null;

    const valueCols = buildValueCols(data, bandRow, indicatorCol, dataStartRow);
    if (!valueCols.length) return null;

    return { indicatorCol, bandRow, subHeaderRow, valueCols, dataStartRow };
}

function isCurrencyLabel(text) {
    return /^[A-Z]{3}$/.test(String(text || '').trim());
}

function isHeaderLabel(text) {
    return /^(счет|акции|валюта|показател)/i.test(String(text || '').trim());
}

function detectUkOsv58Block(data) {
    const titleHint = (data || [])
        .slice(0, 15)
        .some((row) => UK_OSV_58_TITLE_RE.test((row || []).join(' ')));
    const header = findUkOsv58Header(data);
    if (!header) return titleHint ? { titleHint, header: null } : null;

    let buKolRows = 0;
    let acc58Rows = 0;
    for (let i = header.dataStartRow; i < Math.min(data.length, header.dataStartRow + 80); i++) {
        const indicator = normalizeIndicator(cellText(data[i], header.indicatorCol));
        if (indicator) buKolRows++;
        if (UK_ACCOUNT_58_RE.test(cellText(data[i], 0))) acc58Rows++;
    }

    return { titleHint, header, buKolRows, acc58Rows };
}

function detectUkOsv58Score(data) {
    const block = detectUkOsv58Block(data);
    if (!block?.header) return 0;
    if (block.buKolRows < 4) return 0;

    let score = 0.9;
    if (block.titleHint) score = 0.96;
    if (block.acc58Rows >= 1) score = Math.min(0.98, score + 0.02);
    return score;
}

function parseUkOsv58Sheet(data) {
    const block = detectUkOsv58Block(data);
    if (!block?.header || block.buKolRows < 2) return null;

    const { indicatorCol, valueCols, dataStartRow } = block.header;
    const fund = readFundFromHeader(data);
    const accountFromTitle = readAccountFromTitle(data);
    const measureHeaders = buildMeasureHeaders(valueCols);

    const headers = ['Фонд', 'Счёт', 'Наименование', 'Валюта', ...measureHeaders];
    const rows = [];

    let currentAccount = accountFromTitle;
    let currentRecord = null;

    const flushRecord = () => {
        if (!currentRecord) return;
        if (!currentRecord.buRow && !currentRecord.kolRow) {
            currentRecord = null;
            return;
        }
        rows.push(materializeUkOsvRecord(currentRecord, fund, valueCols, measureHeaders));
        currentRecord = null;
    };

    const startRecord = (account, name) => {
        flushRecord();
        currentRecord = { account, name, currency: '', buRow: null, kolRow: null };
    };

    for (let i = dataStartRow; i < data.length; i++) {
        const row = data[i] || [];
        const name = cellText(row, 0);
        const indicator = normalizeIndicator(cellText(row, indicatorCol));
        if (!indicator) continue;
        if (/^итого/i.test(name)) break;

        if (name && !isHeaderLabel(name)) {
            if (UK_ACCOUNT_58_RE.test(name)) {
                currentAccount = name;
                if (!currentRecord || currentRecord.name !== name) {
                    startRecord(name, name);
                }
            } else if (isCurrencyLabel(name)) {
                if (currentRecord) currentRecord.currency = name;
                continue;
            } else if (!currentRecord || currentRecord.name !== name) {
                startRecord(currentAccount, name);
            }
        }

        if (!currentRecord) {
            startRecord(currentAccount, currentAccount || name);
        }

        if (!rowHasAmounts(row, valueCols) && !name) continue;

        if (indicator === 'БУ') currentRecord.buRow = row;
        if (indicator === 'Кол.') currentRecord.kolRow = row;
    }

    flushRecord();

    if (!rows.length) return null;
    const tableMeta = inferTableMeta(headers, 'uk_osv_58');
    return { headers, rows, scenarioId: 'uk_osv_58', tableMeta };
}

function loadSheetRows(buffer, sheetName) {
    const loaded = readSheetWithMeta(buffer, sheetName, { useExcelProbe: true });
    return loaded.data || [];
}

function parseUkOsv58FromBuffer(buffer, sheetName) {
    const data = loadSheetRows(buffer, sheetName);
    if (!data.length) return null;
    if (detectUkOsv58Score(data) < 0.85) return null;
    return parseUkOsv58Sheet(data);
}

async function importUkOsvParseToSnapshot(pool, { file, sheetName, projectId, parsed }) {
    const { createParseSnapshotStore } = require('./parse_snapshot_store');
    const store = createParseSnapshotStore(pool);
    const sid = await store.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: file.originalname,
        sheetName,
        scenarioId: parsed.scenarioId,
        headers: parsed.headers,
        tableMeta: parsed.tableMeta || null,
        status: 'parsing',
    });
    const rowCount = await store.importParsedRows(sid, parsed.headers, parsed.rows, parsed.tableMeta);
    const previewRows = parsed.rows.slice(0, 200);
    return {
        ok: true,
        snapshotId: sid,
        parsePreview: { ok: true, headers: parsed.headers, rows: previewRows, rowCount, tableMeta: parsed.tableMeta || null },
        warnings: [],
    };
}

async function tryParseUkOsv58Sheet({ pool, file, sheetName, projectId, data }) {
    const rows = data || loadSheetRows(file.buffer, sheetName);
    const parsed = parseUkOsv58Sheet(rows);
    if (!parsed?.rows?.length) return null;

    const imported = await importUkOsvParseToSnapshot(pool, { file, sheetName, projectId, parsed });
    if (!imported.ok) return null;

    return {
        ok: true,
        sheetName,
        scenarioId: parsed.scenarioId,
        scenarioName: 'ОСВ УК 58.01 (дерево)',
        snapshotId: imported.snapshotId,
        rowCount: imported.parsePreview.rowCount,
        parsePreview: imported.parsePreview,
        warnings: imported.warnings,
    };
}

function detectUkOsv58ProfileScore(ctx) {
    const data = ctx.data || [];
    const structure = ctx.structure;
    if (structure?.structure_id === 'uk_osv_58' && structure.autoParse) {
        const parsed = parseUkOsv58Sheet(data);
        return parsed?.rows?.length ? Math.max(structure.confidence, 0.96) : structure.confidence * 0.9;
    }
    const score = detectUkOsv58Score(data);
    if (score < 0.85) return 0;
    const parsed = parseUkOsv58Sheet(data);
    return parsed?.rows?.length ? Math.max(score, 0.96) : score * 0.9;
}

module.exports = {
    UK_OSV_58_TITLE_RE,
    detectUkOsv58Block,
    detectUkOsv58Score,
    findUkOsv58Header,
    buildValueCols,
    dedupeValueCols,
    buildMeasureHeaders,
    parseUkOsv58Sheet,
    parseUkOsv58FromBuffer,
    tryParseUkOsv58Sheet,
    detectUkOsv58ProfileScore,
};
