/**
 * Извлечение таблиц из PDF по координатам текстового слоя (pdfjs-dist).
 */

const { isSectionAnchorRow } = require('./pdf_section_anchors');
const { ISIN_RE } = require('./broker_pdf_utils');

const NUMERIC_HEADER_RE = /количество|сумма|в рублях|цена|нкд|стоимость|планируем|плани|руемая|позици|доступн|валют/i;
const HEADER_FOOTNOTE_RE = /[\u00B9\u00B2\u00B3\u2070-\u2079\u2080-\u2089]/g;
const NUMERIC_VALUE_RE = /^-?\d{1,3}(?: \d{3})*(?:,\d+)?$/;
const CURRENCY_RE = /^(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED)$/;
const PAGE_NOISE_RES = [
    /^Страница\s+\d+\s+из\s+\d+/i,
    /^--\s*\d+\s+of\s+\d+\s*--$/i,
];
const SECTION_GRID_PROFILES = {
    encumbered: { minCols: 10, maxCols: 18, targetCols: 14, tolMin: 8, tolMax: 14, cellGap: 8 },
    trades: { minCols: 18, maxCols: 23, targetCols: 21, tolMin: 6, tolMax: 10, cellGap: 6 },
    reserved: { minCols: 5, maxCols: 12, targetCols: 7, tolMin: 10, tolMax: 28, cellGap: 10 },
    assets: { minCols: 4, maxCols: 8, targetCols: 6, tolMin: 18, tolMax: 40, cellGap: 12 },
    operations: { minCols: 4, maxCols: 8, targetCols: 6, tolMin: 12, tolMax: 35, cellGap: 10 },
    default: { minCols: 3, maxCols: 25, targetCols: null, tolMin: 12, tolMax: 40, cellGap: 12 },
};

function getSectionGridProfile(sectionId) {
    return SECTION_GRID_PROFILES[sectionId] || SECTION_GRID_PROFILES.default;
}

let pdfjsModule = null;

async function getPdfjs() {
    if (!pdfjsModule) {
        pdfjsModule = await import('pdfjs-dist/legacy/build/pdf.mjs');
    }
    return pdfjsModule;
}

/**
 * @param {Buffer} buffer
 * @param {number[]|null} [pageRanges]
 */
async function extractTextItems(buffer, pageRanges = null) {
    const pdfjs = await getPdfjs();
    const doc = await pdfjs.getDocument({
        data: new Uint8Array(buffer),
        useSystemFonts: true,
        disableFontFace: true,
    }).promise;

    const items = [];
    for (let p = 1; p <= doc.numPages; p++) {
        if (pageRanges && !pageRanges.includes(p)) continue;
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        for (const it of tc.items) {
            const text = String(it.str || '').trim();
            if (!text) continue;
            items.push({
                page: p,
                text,
                x: it.transform[4],
                y: it.transform[5],
                w: it.width || 0,
            });
        }
    }
    return { items, pageCount: doc.numPages };
}

function isNoiseRow(text) {
    return PAGE_NOISE_RES.some((re) => re.test(String(text || '')));
}

/**
 * @param {{ page: number, text: string, x: number, y: number }[]} items
 * @param {number} [yTol]
 */
function clusterRows(items, yTol = 4) {
    const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of sorted) {
        let row = rows.find((r) => r.page === it.page && Math.abs(r.y - it.y) <= yTol);
        if (!row) {
            row = { page: it.page, y: it.y, items: [] };
            rows.push(row);
        }
        row.items.push(it);
    }
    for (const row of rows) {
        row.items.sort((a, b) => a.x - b.x);
        row.text = row.items.map((i) => i.text).join(' ');
    }
    rows.sort((a, b) => a.page - b.page || b.y - a.y);
    return rows.filter((r) => !isNoiseRow(r.text));
}

function rowToCellGroups(row, cellGap = 12) {
    const items = [...row.items].sort((a, b) => a.x - b.x);
    const groups = [];
    for (const it of items) {
        const prev = groups[groups.length - 1];
        if (prev && it.x - prev.right <= cellGap) {
            prev.items.push(it);
            prev.right = Math.max(prev.right, it.x + (it.w || 0));
            prev.text = `${prev.text} ${it.text}`.trim();
        } else {
            groups.push({
                items: [it],
                left: it.x,
                right: it.x + (it.w || 0),
                text: it.text,
            });
        }
    }
    return groups;
}

function isDataRowText(text) {
    const t = String(text || '');
    if (/^ИТОГО\b/i.test(t)) return false;
    if (/mcxs\d+/i.test(t)) return true;
    if (/^ПАО/.test(t) && ISIN_RE.test(t)) return true;
    if (ISIN_RE.test(t) && /\d{1,3}(?: \d{3})/.test(t)) return true;
    if (ISIN_RE.test(t) && t.length > 15) return true;
    if (/^\d{1,3}\s/.test(t) && /\d{2}\.\d{2}\.\d{2}/.test(t) && /-?\d+,\d{2}/.test(t)) return true;
    if (/(Рыночная стоимость|Доступно средств|Планируемая позиция)/i.test(t) && /\d{1,3}(?: \d{3})*,\d{2}/.test(t)) {
        return true;
    }
    return false;
}

function findFirstDataRowByText(regionRows) {
    for (let i = 0; i < regionRows.length; i++) {
        if (isDataRowText(regionRows[i].text)) return i;
    }
    return -1;
}

function clusterPositions(positions, xTol = 40) {
    const xs = [...positions].sort((a, b) => a - b);
    if (!xs.length) return [];
    const centers = [];
    let bucket = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
        if (xs[i] - xs[i - 1] <= xTol) bucket.push(xs[i]);
        else {
            centers.push(bucket.reduce((a, b) => a + b, 0) / bucket.length);
            bucket = [xs[i]];
        }
    }
    centers.push(bucket.reduce((a, b) => a + b, 0) / bucket.length);
    return centers;
}

function columnCentersFromDataRows(regionRows, dataStart, sampleCount = 8, xTol = 40) {
    const end = Math.min(regionRows.length, dataStart + sampleCount);
    let bestGroups = null;
    let bestCount = 0;
    const lefts = [];

    for (let i = dataStart; i < end; i++) {
        if (!isDataRowText(regionRows[i].text)) continue;
        const groups = rowToCellGroups(regionRows[i], 8);
        if (groups.length > bestCount) {
            bestCount = groups.length;
            bestGroups = groups;
        }
        for (const g of groups) lefts.push(g.left);
    }

    if (bestGroups?.length >= 2) {
        return bestGroups.map((g) => g.left);
    }
    if (lefts.length >= 2) return clusterPositions(lefts, xTol);
    return rowToCellGroups(regionRows[dataStart], 8).map((g) => g.left);
}

function columnCentersFromHeaderRows(regionRows, dataStart) {
    let bestGroups = null;
    for (let i = 0; i < dataStart; i++) {
        const groups = rowToCellGroups(regionRows[i], 8);
        if (!bestGroups || groups.length > bestGroups.length) bestGroups = groups;
    }
    return bestGroups?.length >= 2 ? bestGroups.map((g) => g.left) : [];
}

function resolveColumnCenters(regionRows, dataStart, xTol = 40) {
    const fromData = columnCentersFromDataRows(regionRows, dataStart, 12, xTol);
    if (fromData.length >= 2) return fromData;
    const fromHeaders = columnCentersFromHeaderRows(regionRows, dataStart);
    return fromHeaders.length >= 2 ? fromHeaders : fromData;
}

function sampleDataRows(regionRows, dataStart, sampleCount = 25) {
    const rows = [];
    for (let i = dataStart; i < Math.min(regionRows.length, dataStart + sampleCount); i++) {
        if (isDataRowText(regionRows[i].text)) rows.push(regionRows[i]);
    }
    return rows;
}

function assignItemsToColumns(row, colCenters, xTol) {
    const cells = new Array(colCenters.length).fill('');
    const items = row?.items || [];
    for (const it of items) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < colCenters.length; i++) {
            const d = Math.abs(it.x - colCenters[i]);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        const withinTol = bestDist <= xTol * 1.5;
        const pastLastCol = it.x >= colCenters[colCenters.length - 1] - xTol;
        if (withinTol || pastLastCol) {
            const idx = withinTol ? bestIdx : colCenters.length - 1;
            cells[idx] = cells[idx] ? `${cells[idx]} ${it.text}` : it.text;
        }
    }
    return cells.map((c) => c.trim());
}

function scoreColumnLayout(sampleRows, centers, xTol) {
    let score = 0;
    for (const row of sampleRows) {
        const cells = assignItemsToColumns(row, centers, xTol);
        const nonEmpty = cells.filter(Boolean).length;
        const nums = countNumericCells(cells);
        if (nonEmpty >= 2) score += nonEmpty + nums * 0.3;
        for (let j = 1; j < cells.length; j++) {
            if (cells[j] && cells[j].length > 90) score -= 1.5;
        }
        if (cells[0] && cells[0].length > 120) score -= 1;
    }
    return score;
}

function inferAdaptiveColumnCenters(regionRows, dataStart, profile = {}) {
    const minCols = profile.minCols ?? 3;
    const maxCols = profile.maxCols ?? 40;
    const targetCols = profile.targetCols ?? null;
    const tolMin = profile.tolMin ?? 8;
    const tolMax = profile.tolMax ?? 35;

    const sampleRows = sampleDataRows(regionRows, dataStart, 25);
    if (!sampleRows.length) {
        const fallback = resolveColumnCenters(regionRows, dataStart, 40);
        return { centers: fallback, xTol: 40 };
    }

    const allXs = [];
    for (const row of sampleRows) {
        for (const it of row.items) allXs.push(it.x);
    }

    let best = { centers: [], score: -Infinity, xTol: tolMax };

    for (let tol = tolMin; tol <= tolMax; tol++) {
        const centers = clusterPositions(allXs, tol);
        if (centers.length < minCols || centers.length > maxCols) continue;

        let score = scoreColumnLayout(sampleRows, centers, tol);
        if (targetCols) score -= Math.abs(centers.length - targetCols) * 1.5;

        if (score > best.score) best = { centers, score, xTol: tol };
    }

    if (best.centers.length >= minCols) return best;

    const fallback = resolveColumnCenters(regionRows, dataStart, 40);
    return { centers: fallback, xTol: 40 };
}

function consolidateColumnCenters(centers, minGap = 9) {
    const sorted = [...(centers || [])].sort((a, b) => a - b);
    if (!sorted.length) return [];
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - out[out.length - 1] >= minGap) {
            out.push(sorted[i]);
        } else {
            out[out.length - 1] = (out[out.length - 1] + sorted[i]) / 2;
        }
    }
    return out;
}

function padColumnCenters(centers, targetCount) {
    if (!centers?.length || !targetCount || centers.length >= targetCount) {
        return centers?.slice(0, targetCount || centers?.length) || [];
    }
    const out = [...centers];
    const span = centers[centers.length - 1] - centers[0];
    const step = span > 0 ? span / Math.max(centers.length - 1, 1) : 40;
    while (out.length < targetCount) {
        out.push(out[out.length - 1] + step);
    }
    return out;
}

function alignCentersToHeaders(centers, headers) {
    const target = headers?.filter(Boolean).length || headers?.length || 0;
    if (!target || !centers?.length) return centers || [];
    if (centers.length >= target) return centers.slice(0, target);
    return padColumnCenters(centers, target);
}

function shouldAssignByItems(sectionId) {
    return sectionId === 'trades' || sectionId === 'encumbered' || sectionId === 'reserved';
}

function assignRowCells(row, colCenters, xTol, sectionId) {
    if (shouldAssignByItems(sectionId)) {
        return assignItemsToColumns(row, colCenters, xTol);
    }
    return assignRowToColumns(row, colCenters, xTol);
}

function fillEmptyHeaders(headers, dataRows) {
    return headers.map((h, i) => {
        if (String(h || '').trim()) return h;
        const hasData = dataRows.some((r) => String(r[i] || '').trim());
        if (!hasData) return '';
        if (i === 0 && dataRows.some((r) => ISIN_RE.test(String(r[i] || '')))) {
            return 'ЦБ (эмитент / ISIN / код гос. регистрации)';
        }
        return `col_${i + 1}`;
    });
}

function assignRowToColumns(row, colCenters, xTol = 40) {
    const cells = new Array(colCenters.length).fill('');
    for (const g of rowToCellGroups(row)) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < colCenters.length; i++) {
            const d = Math.abs(g.left - colCenters[i]);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        if (bestDist <= xTol) {
            cells[bestIdx] = cells[bestIdx] ? `${cells[bestIdx]} ${g.text}` : g.text;
        }
    }
    return cells.map((c) => c.trim());
}

function isNumericCell(c) {
    const t = String(c || '').trim();
    if (!t) return false;
    if (CURRENCY_RE.test(t)) return true;
    if (!NUMERIC_VALUE_RE.test(t)) return false;
    if (/^\d{1,2}$/.test(t)) return false;
    return true;
}

function assignToColumns(row, colCenters, xTol = 25) {
    const cells = new Array(colCenters.length).fill('');
    for (const it of row.items) {
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < colCenters.length; i++) {
            const d = Math.abs(it.x - colCenters[i]);
            if (d < bestDist) {
                bestDist = d;
                bestIdx = i;
            }
        }
        if (bestDist <= xTol * 1.5) {
            cells[bestIdx] = cells[bestIdx] ? `${cells[bestIdx]} ${it.text}` : it.text;
        }
    }
    return cells.map((c) => c.trim());
}

function countNumericCells(cells) {
    return cells.filter((c) => isNumericCell(c)).length;
}

function isLikelyDataRow(cells) {
    const nonEmpty = cells.filter(Boolean);
    if (nonEmpty.length === 1 && ISIN_RE.test(nonEmpty[0])) return true;
    if (nonEmpty.length < 2) return false;
    const nums = countNumericCells(cells);
    if (nums >= 2) return true;
    if (cells.some((c) => /mcxs\d+/i.test(c))) return true;
    if (cells.some((c) => ISIN_RE.test(c))) return true;
    if (cells[0] && /^ПАО|ООО|АО /i.test(cells[0]) && nums >= 1) return true;
    if (cells.some((c) => CURRENCY_RE.test(c)) && nums >= 1) return true;
    if (/^\d+$/.test(cells[0] || '') && nums >= 1) return true;
    return false;
}

function cleanHeaderCell(h) {
    return String(h || '')
        .replace(HEADER_FOOTNOTE_RE, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function dedupeConsecutiveWords(s) {
    const words = String(s || '').split(/\s+/).filter(Boolean);
    const out = [];
    for (const w of words) {
        if (out.length && out[out.length - 1].toLowerCase() === w.toLowerCase()) continue;
        out.push(w);
    }
    return out.join(' ');
}

function makeUniqueHeaders(headers) {
    const cleaned = headers.map((h) => dedupeConsecutiveWords(cleanHeaderCell(h)));
    const out = [...cleaned];
    const firstIdx = {};

    for (let i = 0; i < out.length; i++) {
        const label = out[i];
        if (!label) continue;

        if (firstIdx[label] === undefined) {
            firstIdx[label] = i;
            continue;
        }

        const first = firstIdx[label];
        const mirror = /количество|цена|стоимость|валют|нкд|доступн/i.test(label);
        if (mirror && !/\(на (начало|конец)\)/i.test(out[first])) {
            out[first] = `${label} (на начало)`;
            out[i] = `${label} (на конец)`;
        } else if (!/\(\d+\)$/.test(out[i])) {
            let n = 2;
            let candidate = `${label} (${n})`;
            while (out.includes(candidate)) {
                n++;
                candidate = `${label} (${n})`;
            }
            out[i] = candidate;
        }
    }

    return out;
}

function mergeMultilineHeaders(headerRows, colCount) {
    const merged = new Array(colCount).fill('');
    for (const row of headerRows) {
        for (let i = 0; i < colCount; i++) {
            const v = row[i] || '';
            if (!v) continue;
            merged[i] = merged[i] ? `${merged[i]} ${v}` : v;
        }
    }
    return makeUniqueHeaders(merged.map((h) => dedupeConsecutiveWords(cleanHeaderCell(h))));
}

const TRADE_ROW_ANCHOR_RE = /mcxs\d+/i;

function isTradeDataRowAnchor(srcText) {
    return TRADE_ROW_ANCHOR_RE.test(String(srcText || ''));
}

function isTradeContinuationText(srcText) {
    const t = String(srcText || '').trim();
    if (!t || isTradeDataRowAnchor(t)) return false;
    if (/^рынок/i.test(t)) return true;
    if (/^Биржа,\s*Фондовый/i.test(t)) return true;
    if (/^Биржа,/i.test(t) && /\d{2}\.\d{2}\.\d{2}/.test(t)) return true;
    if (/^\d{1,4}\s/.test(t) && (/\d{2}\.\d{2}\.\d{2}/.test(t) || /Часть\s+[12]/i.test(t))) return true;
    if (/^[A-Z0-9()\\/.\s-]+$/i.test(t) && /-\d{2}-[A-Z0-9]$/i.test(t)) return true;
    if (/^\d{5}-[A-Z0-9]$/i.test(t)) return true;
    return false;
}

/**
 * Склейка визуальных строк PDF до разбиения по колонкам (ATON trades: 2–3 Y-линии на сделку).
 */
function mergeTradesClusterRows(dataRows) {
    if (!dataRows?.length) return [];
    const merged = [];
    for (const row of dataRows) {
        const srcText = row.text || '';
        if (!merged.length || isTradeDataRowAnchor(srcText)) {
            merged.push({ ...row, items: [...(row.items || [])] });
            continue;
        }
        if (isTradeContinuationText(srcText)) {
            const prev = merged[merged.length - 1];
            prev.items = [...(prev.items || []), ...(row.items || [])];
            prev.text = `${prev.text || ''} ${srcText}`.replace(/\s+/g, ' ').trim();
            continue;
        }
        merged.push({ ...row, items: [...(row.items || [])] });
    }
    return merged;
}

function mergeCellArrays(into, from) {
    const colCount = Math.max(into.length, from.length);
    while (into.length < colCount) into.push('');
    for (let i = 0; i < colCount; i++) {
        const a = String(into[i] || '').trim();
        const b = String(from[i] || '').trim();
        if (!b) continue;
        if (!a) into[i] = b;
        else if (a === b) continue;
        else into[i] = `${a} ${b}`.replace(/\s+/g, ' ').trim();
    }
    return into;
}

/**
 * Склеивает визуальные строки PDF в логические записи (ATON trades: 2–3 линии на сделку).
 * @param {{ cells: string[], srcText: string }[]} rowPairs
 */
function mergeMultilineDataRows(rowPairs, sectionId) {
    if (sectionId !== 'trades' || !rowPairs?.length) {
        return rowPairs?.map((p) => p.cells) || [];
    }

    const merged = [];
    for (const { cells, srcText } of rowPairs) {
        if (!merged.length || isTradeDataRowAnchor(srcText)) {
            merged.push([...cells]);
            continue;
        }
        mergeCellArrays(merged[merged.length - 1], cells);
    }
    return merged;
}

function parseRuNumber(s) {
    if (s == null || s === '') return s;
    const t = String(s).trim();
    if (!NUMERIC_VALUE_RE.test(t)) return s;
    const n = parseFloat(t.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : s;
}

function coerceCell(header, value) {
    if (value == null || value === '') return value;
    const t = String(value).trim();
    if (CURRENCY_RE.test(t)) return t;
    if (NUMERIC_HEADER_RE.test(String(header || ''))) return parseRuNumber(value);
    if (NUMERIC_VALUE_RE.test(t) && !/[а-яёA-Za-z]{2,}/i.test(t)) return parseRuNumber(value);
    return t;
}

function buildRows(headers, dataCellRows) {
    return dataCellRows
        .map((cells) => {
            const row = {};
            for (let i = 0; i < headers.length; i++) {
                const h = headers[i];
                if (!h) continue;
                const v = coerceCell(h, cells[i]);
                if (v !== '' && v != null) row[h] = v;
            }
            return Object.keys(row).length ? row : null;
        })
        .filter(Boolean);
}

function trimEmptyColumns(headers, dataRows) {
    let lastCol = headers.length - 1;
    while (lastCol >= 0 && !headers[lastCol] && !dataRows.some((r) => r[lastCol])) lastCol--;
    if (lastCol < 0) return { headers: [], dataRows: [] };
    const hdrLen = lastCol + 1;
    return {
        headers: headers.slice(0, hdrLen),
        dataRows: dataRows.map((r) => {
            const c = r.slice(0, hdrLen);
            while (c.length < hdrLen) c.push('');
            return c;
        }),
    };
}

/**
 * @param {{ page: number, y: number, items: object[], text: string }[]} rows
 */
const ATON_TRADES_CANONICAL_HEADERS = [
    '№ п/п',
    'Организатор торговли, через которого заключена сделка',
    '№ сделки, дата, время заключения сделки',
    'Вид сделки (покупка/продажа), часть',
    'ЦБ (эмитент / ISIN / код гос. регистрации)',
    'Количество Актива (ЦБ/валюты/драгоценного металла)',
    'Ставка %, срок репо, дисконт (+/-)',
    'Цена одного Актива (ЦБ / валюты/драгоценного металла)',
    'Валюта цены',
    'Валюта расчетов',
    'Сумма сделки в валюте расчетов',
    'Сумма сделки, руб.',
    'НКД в валюте расчетов',
    'НКД, руб.',
    'Дата поставки план / факт',
    'Дата расчетов в реестре / вышестоящем депозитарии',
    'Дата оплаты план / факт',
    'Комиссия ООО "АТОН" по биржевым сделкам',
    'Комиссия биржи за организацию торгов / Клиринговая комиссия НКЦ, руб.',
    'Срок действия ТП',
    'Портфель',
];

const ATON_ENCUMBERED_HEADERS = [
    'ЦБ (эмитент / ISIN / код гос. регистрации)',
    'На начало — Количество ЦБ',
    'На начало — Рыночная цена одной ЦБ (в валюте цены)',
    'На начало — Рыночная стоимость ЦБ (всего)',
    'На начало — НКД (в валюте цены)',
    'На начало — Валюта цены',
    'На конец — Количество ЦБ',
    'На конец — Рыночная цена одной ЦБ (в валюте цены)',
    'На конец — Рыночная стоимость ЦБ (всего)',
    'На конец — НКД (в валюте цены)',
    'На конец — Валюта цены',
    'Планируемая позиция по ЦБ',
];

function applyCanonicalSectionHeaders(headers, sectionId, colCount, visionUsed = false) {
    if (sectionId === 'encumbered' && colCount >= 9) {
        return ATON_ENCUMBERED_HEADERS.slice(0, Math.min(colCount, ATON_ENCUMBERED_HEADERS.length));
    }
    if (sectionId === 'trades' && colCount >= 10) {
        if (visionUsed && headers?.length && !isMessyGridHeaders(headers)) {
            return headers.slice(0, ATON_TRADES_CANONICAL_HEADERS.length);
        }
        return ATON_TRADES_CANONICAL_HEADERS.slice();
    }
    return headers;
}

function mapVisionHeadersToPhysical(visionHeaders, physicalCols, sectionId) {
    if (sectionId === 'encumbered') {
        return applyCanonicalSectionHeaders([], sectionId, physicalCols, true);
    }
    const v = (visionHeaders || []).map((h) => cleanHeaderCell(h));
    if (v.length === physicalCols) return v;
    if (v.length > physicalCols) return compactVisionHeaders(v, physicalCols);
    while (v.length < physicalCols) v.push('');
    return v;
}

function compactVisionHeaders(visionHeaders, physicalCols) {
    const cleaned = (visionHeaders || []).map((h) => cleanHeaderCell(h)).filter(Boolean);
    if (cleaned.length <= physicalCols) return cleaned;
    const skipRe = /доступное для торгов|НКД \(в валюте цены\)|В валюте цены$/i;
    const compact = cleaned.filter((h) => !skipRe.test(h));
    if (compact.length >= physicalCols - 1) return compact.slice(0, physicalCols);
    return cleaned.slice(0, physicalCols);
}

function extractTableFromRows(rows, startIdx, endIdx, options = {}) {
    const slice = rows.slice(startIdx, endIdx);
    if (slice.length < 2) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'pdfjs_grid' };
    }

    const profile = getSectionGridProfile(options.sectionId);
    const regionRows = slice.slice(1);
    const cachedCenters = options.columnCenters;
    const dataStart =
        options.dataStart != null && options.dataStart >= 0
            ? options.dataStart
            : findFirstDataRowByText(regionRows);

    if (dataStart < 0) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'pdfjs_grid' };
    }

    const sectionId = options.sectionId;
    let xTol = options.xTol || 40;
    let colCenters = cachedCenters;

    if (!colCenters?.length || colCenters.length < 2) {
        const inferred = inferAdaptiveColumnCenters(regionRows, dataStart, profile);
        colCenters =
            sectionId === 'trades'
                ? consolidateColumnCenters(inferred.centers, 9)
                : inferred.centers;
        xTol = inferred.xTol;
    }
    if (sectionId === 'trades' && colCenters.length > ATON_TRADES_CANONICAL_HEADERS.length) {
        colCenters = colCenters.slice(0, ATON_TRADES_CANONICAL_HEADERS.length);
    }

    if (options.visionHeaders?.length) {
        /* координаты колонок не меняем — vision только для подписей */
    } else if (options.targetColumnCount && colCenters.length < options.targetColumnCount) {
        colCenters = padColumnCenters(colCenters, options.targetColumnCount);
    }

    if (colCenters.length < 2) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'pdfjs_grid' };
    }

    const cellRows = regionRows.map((r) => assignRowCells(r, colCenters, xTol, sectionId));

    const headerRows = cellRows.slice(0, dataStart);
    const dataRows = cellRows.slice(dataStart);

    const filteredPairs = [];
    for (let idx = 0; idx < dataRows.length; idx++) {
        const cells = dataRows[idx];
        const srcText = regionRows[dataStart + idx]?.text || '';
        if (/^Исполненные\s+сделки$/i.test(srcText)) continue;
        if (/^Неисполненные\s+сделки$/i.test(srcText)) continue;
        const tradeContinuation = sectionId === 'trades' && isTradeContinuationText(srcText);
        if (!isDataRowText(srcText) && !tradeContinuation) continue;
        if (!tradeContinuation && !isLikelyDataRow(cells) && !isDataRowText(cells.join(' '))) continue;
        filteredPairs.push({ cells, srcText });
    }
    const filteredData = mergeMultilineDataRows(filteredPairs, sectionId);

    let headers = options.cachedHeaders?.length
        ? options.cachedHeaders.map(cleanHeaderCell)
        : headerRows.length > 0
          ? mergeMultilineHeaders(headerRows, colCenters.length)
          : colCenters.map((_, i) => `col_${i + 1}`);

    if (options.visionHeaders?.length) {
        headers = mapVisionHeadersToPhysical(
            options.visionHeaders,
            colCenters.length,
            options.sectionId
        );
    }

    if (!options.visionHeaders?.length) {
        headers = makeUniqueHeaders(headers);
    }

    if (
        (sectionId === 'encumbered' || sectionId === 'trades') &&
        (options.visionHeaders?.length || isMessyGridHeaders(headers))
    ) {
        headers = applyCanonicalSectionHeaders(
            headers,
            sectionId,
            colCenters.length,
            !!options.visionHeaders?.length
        );
    }

    let trimmed = trimEmptyColumns(headers, filteredData);
    if (sectionId === 'trades') {
        const limit = ATON_TRADES_CANONICAL_HEADERS.length;
        trimmed = {
            headers: trimmed.headers.slice(0, limit),
            dataRows: trimmed.dataRows.map((r) => r.slice(0, limit)),
        };
    }
    headers = fillEmptyHeaders(trimmed.headers, trimmed.dataRows);
    const normalizedData = trimmed.dataRows;

    let outRows = buildRows(headers, normalizedData);
    if (sectionId === 'trades' && outRows.length) {
        outRows = repairAtonTradesRows(outRows, headers);
    }
    const confidence =
        outRows.length >= 2 ? Math.min(0.95, 0.72 + Math.min(outRows.length, 20) * 0.01) : 0.55;

    return {
        ok: outRows.length > 0,
        headers,
        rows: outRows,
        confidence,
        method: options.method || 'pdfjs_grid',
        meta: {
            columns: colCenters.length,
            columnCenters: colCenters,
            dataStart,
            headerRowCount: headerRows.length,
            sectionPage: slice[0]?.page ?? regionRows[0]?.page ?? null,
            xTol,
            sectionId: options.sectionId || null,
        },
    };
}

function findSectionRowIndex(rows, patterns) {
    for (let i = 0; i < rows.length; i++) {
        if (patterns.some((re) => re.test(rows[i].text))) return i;
    }
    return -1;
}

/**
 * @param {Buffer} buffer
 * @param {{ anchorStart?: RegExp|string, anchorEnd?: RegExp|string, pageRanges?: number[], yTol?: number, xTol?: number }} [options]
 */
async function extractTableGridFromPdf(buffer, options = {}) {
    const { items } = await extractTextItems(buffer, options.pageRanges || null);
    const rows = clusterRows(items, options.yTol || 4);

    let startIdx = 0;
    let endIdx = rows.length;

    if (options.anchorStart) {
        const re =
            options.anchorStart instanceof RegExp
                ? options.anchorStart
                : new RegExp(options.anchorStart, 'i');
        startIdx = findSectionRowIndex(rows, [re]);
        if (startIdx < 0) {
            return { ok: false, headers: [], rows: [], confidence: 0, method: 'pdfjs_grid' };
        }
    }

    if (options.anchorEnd) {
        const re =
            options.anchorEnd instanceof RegExp ? options.anchorEnd : new RegExp(options.anchorEnd, 'i');
        for (let i = startIdx + 1; i < rows.length; i++) {
            if (re.test(rows[i].text)) {
                endIdx = i;
                break;
            }
        }
    }

    return extractTableFromRows(rows, startIdx, endIdx, options);
}

/**
 * @param {Buffer} buffer
 * @param {{ id: string, label: string, patterns: RegExp[] }[]} sectionDefs
 * @param {string[]|null} [filterIds]
 */
async function extractSectionsFromGrid(buffer, sectionDefs, filterIds = null) {
    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);

    const starts = [];
    for (let i = 0; i < rows.length; i++) {
        for (const def of sectionDefs) {
            if (isSectionAnchorRow(rows[i].text, def)) {
                starts.push({ index: i, def });
                break;
            }
        }
    }

    starts.sort((a, b) => a.index - b.index);
    const deduped = [];
    const seen = new Set();
    for (const s of starts) {
        if (seen.has(s.def.id)) continue;
        seen.add(s.def.id);
        deduped.push(s);
    }

    const sections = [];
    for (let i = 0; i < deduped.length; i++) {
        const { index, def } = deduped[i];
        if (filterIds && !filterIds.includes(def.id)) continue;
        const end = i + 1 < deduped.length ? deduped[i + 1].index : rows.length;
        const extracted = extractTableFromRows(rows, index, end, { sectionId: def.id });
        if (!extracted.ok || !extracted.rows.length) continue;
        sections.push({
            id: def.id,
            label: def.label,
            headers: extracted.headers,
            rows: extracted.rows,
            confidence: extracted.confidence,
            method: extracted.method,
            meta: extracted.meta,
        });
    }
    return sections;
}

function isReasonableGridTable(result) {
    if (!result?.ok || !result.rows?.length) return false;
    const headers = result.headers || [];
    if (headers.length < 2) return false;
    const longHeaders = headers.filter((h) => String(h).length > 100).length;
    if (longHeaders > Math.max(1, Math.floor(headers.length / 2))) return false;
    return true;
}

function findAtonTradesColumnKeys(headers) {
    const list = headers || [];
    return {
        rowNum:
            list.find((h) => /^№\s*п\/п$/i.test(String(h).trim())) ||
            list.find((h) => /п\/п/i.test(String(h))) ||
            null,
        organizer:
            list.find((h) => /организатор/i.test(String(h))) ||
            list.find((h) => /^пao$/i.test(String(h).trim())) ||
            null,
        deal:
            list.find((h) => /№\s*сделк/i.test(String(h))) ||
            list.find((h) => /^col_3$/i.test(String(h))) ||
            null,
        dealType:
            list.find((h) => /вид\s+сделки/i.test(String(h))) ||
            list.find((h) => /покупк.*продаж/i.test(String(h))) ||
            null,
    };
}

function isSplitAtonTradePair(rowA, rowB, keys) {
    if (!rowA || !rowB) return false;
    const aNum = keys.rowNum ? rowA[keys.rowNum] : null;
    const bNum = keys.rowNum ? rowB[keys.rowNum] : null;
    if (aNum != null && String(aNum).trim() !== '') return false;
    if (bNum == null || String(bNum).trim() === '') return false;

    const aDeal = String(keys.deal ? rowA[keys.deal] || '' : '');
    const bDeal = String(keys.deal ? rowB[keys.deal] || '' : '');
    const aType = String(keys.dealType ? rowA[keys.dealType] || '' : '');
    const bType = String(keys.dealType ? rowB[keys.dealType] || '' : '');
    const aOrg = String(keys.organizer ? rowA[keys.organizer] || '' : '');
    const bOrg = String(keys.organizer ? rowB[keys.organizer] || '' : '');

    if (/mcxs\d+/i.test(aDeal) && !/mcxs\d+/i.test(bDeal) && /\d{2}\.\d{2}\.\d{2}/.test(bDeal)) {
        return true;
    }
    if (/^Продажа,\s*$/i.test(aType) && /Часть\s+[12]/i.test(bType)) return true;
    if (/^Покупка,\s*$/i.test(aType) && /Часть\s+[12]/i.test(bType)) return true;
    if (/^Московская/i.test(aOrg) && /^Биржа/i.test(bOrg)) return true;
    return false;
}

function mergeTradeRowObjects(rowA, rowB, headers) {
    const out = { ...rowA };
    for (const h of headers || []) {
        const a = String(out[h] ?? '').trim();
        const b = String(rowB[h] ?? '').trim();
        if (!b) continue;
        if (!a) out[h] = rowB[h];
        else if (a !== b) out[h] = `${a} ${b}`.replace(/\s+/g, ' ').trim();
    }
    return out;
}

function repairAtonTradesRows(rows, headers) {
    if (!rows?.length) return rows;
    const keys = findAtonTradesColumnKeys(headers);
    const repaired = [];
    for (let i = 0; i < rows.length; i++) {
        const cur = rows[i];
        const next = rows[i + 1];
        if (next && isSplitAtonTradePair(cur, next, keys)) {
            repaired.push(mergeTradeRowObjects(cur, next, headers));
            i++;
            continue;
        }
        repaired.push(cur);
    }
    return repaired;
}

function isMessyGridHeaders(headers) {
    const h = (headers || []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!h.length) return true;
    if (h.some((x) => /^col_\d+$/i.test(x))) return true;
    if (h.some((x) => /^ПАО$/i.test(x))) return true;
    if (h.some((x) => /\(2\)$|\(всего\)\s*1/i.test(x))) return true;
    if (h.some((x) => /^На начало 1|^На конец 1/i.test(x))) return true;
    if (h.some((x) => /^ЦБ$/i.test(x))) return true;
    if (h.some((x) => /Плани-\s*руемая/i.test(x))) return true;
    const shortFrag = h.filter((x) => x.length <= 12 && !/валют|rur|usd/i.test(x)).length;
    if (shortFrag >= 2) return true;
    return false;
}

function needsVisionStructure(gridResult, sectionId) {
    if (isMessyGridHeaders(gridResult?.headers)) return true;
    const profile = getSectionGridProfile(sectionId);
    if (!gridResult?.ok || !gridResult.rows?.length) return true;
    if ((gridResult.confidence || 0) < 0.65) return true;
    const headers = gridResult.headers || [];
    const cols = gridResult.meta?.columns || countNonEmptyHeaders(headers);
    if (headers.filter(Boolean).length < 2) return true;
    if (profile.targetCols && cols < profile.targetCols - 1) return true;
    const longHeaders = headers.filter((h) => String(h).length > 100).length;
    if (longHeaders > Math.max(1, Math.floor(headers.length / 2))) return true;
    return false;
}

function countNonEmptyHeaders(headers) {
    return (headers || []).filter((h) => String(h || '').trim()).length > 0;
}

module.exports = {
    extractTextItems,
    clusterRows,
    rowToCellGroups,
    assignRowToColumns,
    extractTableFromRows,
    extractTableGridFromPdf,
    extractSectionsFromGrid,
    findSectionRowIndex,
    parseRuNumber,
    coerceCell,
    isLikelyDataRow,
    isDataRowText,
    isReasonableGridTable,
    isMessyGridHeaders,
    needsVisionStructure,
    countNonEmptyHeaders,
    getSectionGridProfile,
    inferAdaptiveColumnCenters,
    assignItemsToColumns,
    alignCentersToHeaders,
    cleanHeaderCell,
    mergeMultilineHeaders,
    mergeMultilineDataRows,
    mergeCellArrays,
    mergeTradesClusterRows,
    repairAtonTradesRows,
    consolidateColumnCenters,
    isTradeDataRowAnchor,
    isTradeContinuationText,
    ATON_TRADES_CANONICAL_HEADERS,
    makeUniqueHeaders,
    resolveColumnCenters,
};
