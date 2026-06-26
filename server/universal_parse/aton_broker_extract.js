/**
 * Извлечение таблиц ATON / ClnBIS из текстового слоя PDF.
 * Колонки и поля — как в исходном отчёте (русские заголовки раздела).
 */

const { ISIN_RE } = require('./broker_pdf_utils');
const {
    extractTextItems,
    clusterRows,
    assignItemsToColumns,
    inferAdaptiveColumnCenters,
    consolidateColumnCenters,
    isTradeContinuationText,
    isTradeDataRowAnchor,
    isDataRowText,
    ATON_TRADES_CANONICAL_HEADERS,
} = require('./pdfjs_table_grid_extract');
const { findSectionBounds } = require('./pdf_section_table_extract');
const CURRENCY_RE = /^(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED)/;
const PAGE_NOISE_RES = [
    /^Страница\s+\d+\s+из\s+\d+/i,
    /^--\s*\d+\s+of\s+\d+\s*--$/i,
    /^Номер брокерского счета\s*\d+/i,
    /^\/$/,
];
const ORGANIZER_PREFIX = 'ПАО Московская Биржа, Фондовый рынок';
const RU_AMOUNT_RE = /(\d{1,3}(?: \d{3})*,\d{2})/g;
const DEAL_NO_RE = /(mcxs\d+,\s*\d{2}\.\d{2}\.\d{2},\s*\d{2}:\d{2}:\d{2})/i;
const DEAL_TYPE_RE = /(Покупка|Продажа)(?:,\s*)?(Часть\s*\d)?/i;

/** Метаданные шапки отчёта ATON — одни и те же значения во всех строках таблицы. */
const ATON_REPORT_HEADER_COLS = {
    account: 'Номер брокерского счета клиента',
    contract: 'Договор о брокерском обслуживании',
    reportDate: 'Дата составления отчета',
};
const ATON_REPORT_HEADER_KEYS = Object.values(ATON_REPORT_HEADER_COLS);

/** Полный набор колонок «Исполненные сделки» в стандартном отчёте ATON. */
const ATON_TRADES_HEADERS = ATON_TRADES_CANONICAL_HEADERS;

const ATON_TRADES_GRID_PROFILE = {
    minCols: 18,
    maxCols: 23,
    targetCols: 21,
    tolMin: 6,
    tolMax: 10,
    cellGap: 6,
};

const CURRENCY_ONLY_RE = /^(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED)$/i;
const NUMERIC_CELL_RE = /^-?\d{1,3}(?: \d{3})*(?:,\d+)?$/;
const SMALL_MONEY_RE = /^-?\d{1,3}(?: \d{3})*,\d{2}$/;

const H = {
    assets: [
        'Показатель',
        'Валюта',
        'Количество (на начало)',
        'В рублях (на начало)',
        'Количество (на конец)',
        'В рублях (на конец)',
    ],
    positions: [
        'Организатор торговли',
        'ЦБ (эмитент / ISIN / код гос. регистрации)',
        'Количество ЦБ (на начало)',
        'Количество ЦБ (на конец)',
        'Рыночная цена одной ЦБ (руб.)',
        'Рыночная стоимость ЦБ, доступных для торгов (всего) (руб.)',
        'НКД (руб.)',
    ],
    encumbered: [
        'ЦБ (эмитент / ISIN / код гос. регистрации)',
        'Количество ЦБ (на начало)',
        'В рублях (на начало)',
        'Количество ЦБ (на конец)',
        'В рублях (на конец)',
    ],
    trades: ATON_TRADES_HEADERS,
    operations: [
        '№ п/п',
        'Дата начисления',
        'Дата оплаты',
        'Описание операции',
        'Сумма, руб.',
        'Портфель',
    ],
};

/** ClnBIS/GI: широкая таблица зарезервированных ЦБ (внебиржа). */
const CLNBIS_RESERVED_HEADERS = [
    'ЦБ (эмитент / ISIN / код гос. регистрации)',
    'На начало — Количество ЦБ',
    'На начало — Количество ЦБ, доступное для торгов',
    'На начало — Рыночная цена одной ЦБ (в валюте цены)',
    'На начало — Рыночная стоимость ЦБ, доступных для торгов (всего)',
    'На начало — НКД (в валюте цены)',
    'На начало — Валюта цены',
    'На конец — Количество ЦБ',
    'На конец — Количество ЦБ, доступное для торгов',
    'На конец — Рыночная цена одной ЦБ (в валюте цены)',
    'На конец — Рыночная стоимость ЦБ, доступных для торгов (всего)',
    'На конец — НКД (в валюте цены)',
    'На конец — Валюта цены',
    'Планируемая позиция по ЦБ',
];

function stripAtonPageNoise(lines) {
    return (lines || [])
        .map((l) => String(l || '').trim())
        .filter((line) => line && !PAGE_NOISE_RES.some((re) => re.test(line)));
}

function extractRuAmounts(text) {
    const out = [];
    let m;
    const re = new RegExp(RU_AMOUNT_RE.source, 'g');
    while ((m = re.exec(String(text || '')))) {
        out.push(m[1].trim());
    }
    return out;
}

function ruAmountToNumber(s) {
    const n = parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

function pickLargestRuAmount(text) {
    const amts = extractRuAmounts(text);
    if (!amts.length) return '';
    return amts.sort((a, b) => ruAmountToNumber(b) - ruAmountToNumber(a))[0];
}

function extractQtyTokens(text) {
    return [...String(text || '').matchAll(/(\d{1,3}(?: \d{3})+)/g)].map((m) => m[1].trim());
}

/** Отделяет название ЦБ от склеенного хвоста с количествами/суммами после pdf-parse. */
function splitSecurityAndTail(line) {
    const isinM = String(line || '').match(ISIN_RE);
    if (!isinM) return { cb: String(line || '').trim(), tail: '' };

    const isinPos = line.indexOf(isinM[0]);
    const afterIsin = line.slice(isinPos + isinM[0].length);
    const slashIdx = afterIsin.indexOf('/');
    if (slashIdx < 0) {
        return {
            cb: line.slice(0, isinPos + isinM[0].length).trim(),
            tail: line.slice(isinPos + isinM[0].length).trim(),
        };
    }

    const afterSlash = afterIsin.slice(slashIdx + 1);
    const regM = afterSlash.match(/^([A-Za-z0-9][A-Za-z0-9-]*?)(?=\d{1,3}(?: \d{3}))/);
    const cbEnd = regM
        ? isinPos + isinM[0].length + slashIdx + 1 + regM[1].length
        : isinPos + isinM[0].length + slashIdx + 1 + (afterSlash.match(/^([A-Za-z0-9][A-Za-z0-9-]+)/)?.[1]?.length || 0);

    return {
        cb: line.slice(0, cbEnd).trim(),
        tail: line.slice(cbEnd).trim(),
    };
}

function parseEncumberedTail(tail) {
    if (!tail) {
        return { startQty: '', startRub: '', endQty: '', endRub: '' };
    }

    if (!/RUR/i.test(tail)) {
        const qtys = extractQtyTokens(tail);
        return {
            startQty: qtys[0] || '',
            startRub: '',
            endQty: qtys[1] || '',
            endRub: '',
        };
    }

    const parts = tail.split(/RUR/i).map((s) => s.trim()).filter(Boolean);
    const startBlock = parts[0] || '';
    const endBlock = parts[1] || '';
    const startQtys = extractQtyTokens(startBlock);
    const endQtys = extractQtyTokens(endBlock);

    return {
        startQty: startQtys[0] || '',
        startRub: pickLargestRuAmount(startBlock),
        endQty: endQtys[0] || startQtys[1] || '',
        endRub: pickLargestRuAmount(endBlock),
    };
}

function rowFromHeaders(headers, values) {
    const row = {};
    for (let i = 0; i < headers.length; i++) {
        const v = values[i];
        if (v == null) continue;
        if (typeof v === 'number') {
            if (Number.isFinite(v)) row[headers[i]] = v;
            continue;
        }
        if (String(v).trim() !== '') row[headers[i]] = String(v).trim();
    }
    return Object.keys(row).length ? row : null;
}

function makeResult(headers, rows, method = 'aton_broker') {
    if (!rows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method };
    }
    return {
        ok: true,
        headers,
        rows,
        confidence: Math.min(0.9, 0.55 + Math.min(rows.length, 30) * 0.01),
        method,
    };
}

function normalizeAtonContractValue(raw) {
    let v = String(raw || '').trim();
    if (!v) return '';
    v = v.replace(/^No\s*/i, '№ ').replace(/^N\s*º\s*/i, '№ ');
    if (/^\d/.test(v)) v = `№ ${v}`;
    return v;
}

/** Шапка брокерского отчёта (ATON, ClnBIS/GI Solutions, ВТБ) из текстового слоя PDF. */
function parseAtonReportHeader(lines) {
    const text = (lines || []).map((l) => String(l || '')).join('\n');
    const accountM = text.match(/Номер брокерского счета клиента\s*(\d{5,12})/i);
    const contractM = text.match(/Договор о брокерском обслуживании\s*([^\n]+)/i);
    const dateM = text.match(/Дата составления отчета\s*(\d{2}\.\d{2}\.\d{4})/i);

    const account = accountM?.[1]?.trim() || '';
    const contract = normalizeAtonContractValue(contractM?.[1]);
    const reportDate = dateM?.[1]?.trim() || '';

    return {
        ok: Boolean(account && contract && reportDate),
        account,
        contract,
        reportDate,
        values: {
            [ATON_REPORT_HEADER_COLS.account]: account,
            [ATON_REPORT_HEADER_COLS.contract]: contract,
            [ATON_REPORT_HEADER_COLS.reportDate]: reportDate,
        },
    };
}

function applyAtonReportHeader(headers, rows, headerMeta) {
    if (!headerMeta?.ok || !rows?.length) {
        return { headers: headers || [], rows: rows || [] };
    }
    const metaHeaders = ATON_REPORT_HEADER_KEYS;
    const sectionHeaders = (headers || []).filter((h) => !metaHeaders.includes(h));
    const newHeaders = [...metaHeaders, ...sectionHeaders];
    const newRows = rows.map((row) => {
        const out = { ...headerMeta.values };
        for (const h of sectionHeaders) {
            if (row[h] != null && String(row[h]).trim() !== '') out[h] = row[h];
        }
        return out;
    });
    return { headers: newHeaders, rows: newRows };
}

function isAssetsHeaderNoise(line) {
    return (
        /^(Валюта|Количество|На начало|На конец|В рублях|Денежные средства)$/i.test(line) ||
        /^На началоНа конец$/i.test(line) ||
        /^\d{1,2}$/.test(line)
    );
}

function isAssetsCategoryLine(line) {
    return /^Денежные средства/i.test(line) && !/Доступно|Планируемая|недоступные|счете типа/i.test(line);
}

function parseCurrencyAssetLine(line) {
    const m = String(line || '').match(/^([A-Z]{3})(.+)$/);
    if (!m || !CURRENCY_RE.test(m[1])) return null;
    const amounts = extractRuAmounts(m[2]);
    if (amounts.length < 2) return null;
    return {
        currency: m[1],
        amounts,
    };
}

/** ClnBIS: «Доступно средств…RUR433 290,21…» — подпись склеена с валютой. */
function parseGluedAssetsLine(line) {
    const t = String(line || '').trim();
    const m = t.match(/^(.+?)(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED)(.+)$/i);
    if (!m) return null;
    const label = m[1].trim();
    if (!label || label.length < 4 || /^Денежные\s+средства$/i.test(label)) return null;
    const amounts = extractRuAmounts(m[3]);
    if (amounts.length < 2) return null;
    return {
        label,
        currency: m[2].toUpperCase(),
        amounts,
    };
}

function assetsRowFromParts(label, currency, amounts) {
    return rowFromHeaders(H.assets, [
        label,
        currency,
        amounts[0] || '',
        amounts[1] || '',
        amounts[2] || amounts[0] || '',
        amounts[3] || amounts[1] || '',
    ]);
}

function isLikelyAssetsLabelLine(line) {
    const t = String(line || '').trim();
    return t.length > 3 && !CURRENCY_RE.test(t) && !/^\d{1,2}$/.test(t);
}

function extractAtonAssets(lines) {
    const clean = stripAtonPageNoise(lines);
    const headers = H.assets;
    const rows = [];
    let pendingLabel = '';
    let currentCategoryLabel = '';

    for (const line of clean) {
        const glued = parseGluedAssetsLine(line);
        if (glued) {
            const row = assetsRowFromParts(glued.label, glued.currency, glued.amounts);
            if (row) rows.push(row);
            pendingLabel = '';
            currentCategoryLabel = glued.label;
            continue;
        }

        const cur = parseCurrencyAssetLine(line);
        const label = pendingLabel || currentCategoryLabel;
        if (cur && label) {
            const row = assetsRowFromParts(label, cur.currency, cur.amounts);
            if (row) rows.push(row);
            pendingLabel = '';
            continue;
        }

        if (isAssetsHeaderNoise(line) || isAssetsCategoryLine(line)) continue;
        if (/^Справка о стоимости/i.test(line)) continue;
        if (/^Организатор|^ЦБ \(/i.test(line)) break;

        if (isLikelyAssetsLabelLine(line)) {
            const labelLine = line.replace(/\d+$/, '').trim();
            pendingLabel = labelLine;
            currentCategoryLabel = labelLine;
        }
    }

    return makeResult(headers, rows, 'aton_assets');
}

function parseAtonReservedLine(line) {
    if (!line.startsWith(ORGANIZER_PREFIX)) return null;
    const isinM = line.match(ISIN_RE);
    if (!isinM) return null;

    const isin = isinM[0];
    const idx = line.indexOf(isin);
    const cbText = `${line.slice(ORGANIZER_PREFIX.length, idx).trim()}${line.slice(idx, idx + isin.length)}${line.slice(idx + isin.length).replace(/^[\dA-Z\-/]+/i, '').split(/\d{1,3}(?: \d{3})*,\d{2}/)[0] || ''}`.trim();
    let tail = line.slice(idx + isin.length).replace(/^[\dA-Z\-/]+/i, '');

    const rubAmounts = extractRuAmounts(tail);
    const tailNoRub = tail.replace(RU_AMOUNT_RE, ' ');
    const qtys = [...tailNoRub.matchAll(/(\d{1,3}(?: \d{3})+)/g)].map((x) => x[1].trim());
    const priceMatch = tail.match(/(\d+,\d{3})/);

    return rowFromHeaders(H.positions, [
        ORGANIZER_PREFIX,
        cbText || line.slice(ORGANIZER_PREFIX.length, idx + isin.length).trim(),
        qtys[0] || '',
        qtys[1] || qtys[0] || '',
        priceMatch ? priceMatch[1] : '',
        rubAmounts[0] || '',
        rubAmounts[1] || '',
    ]);
}

function parseAtonEncumberedLine(line) {
    if (!ISIN_RE.test(line) || line.startsWith(ORGANIZER_PREFIX)) return null;

    const { cb, tail } = splitSecurityAndTail(line);
    const { startQty, startRub, endQty, endRub } = parseEncumberedTail(tail);

    return rowFromHeaders(H.encumbered, [cb, startQty, startRub, endQty, endRub]);
}

function extractAtonReserved(lines) {
    const clean = stripAtonPageNoise(lines);
    const rows = [];
    for (const line of clean) {
        if (/^ИТОГО\b/i.test(line)) break;
        if (/^Отчет\s+об\s+операциях/i.test(line)) break;
        let row = parseAtonReservedLine(line);
        if (!row) row = parseForeignReservedLine(line);
        if (row) rows.push(row);
    }
    return makeResult(H.positions, rows, 'aton_positions');
}

/** ClnBIS/GI: ЦБ на внебирже без префикса «ПАО Московская Биржа». */
function normalizeClnbisCbName(text) {
    const t = String(text || '').trim();
    const isinM = t.match(ISIN_RE);
    if (!isinM) return t;
    const pos = t.indexOf(isinM[0]) + isinM[0].length;
    const slash = t.indexOf('/', pos);
    if (slash >= 0) return t.slice(0, slash + 1).trim();
    return t.slice(0, pos + isinM[0].length).trim();
}

function buildClnbisReservedRow(cb, nums) {
    const row = { [CLNBIS_RESERVED_HEADERS[0]]: normalizeClnbisCbName(cb) };
    if (nums.length >= 5) {
        row[CLNBIS_RESERVED_HEADERS[1]] = nums[0];
        row[CLNBIS_RESERVED_HEADERS[2]] = nums[1];
        row[CLNBIS_RESERVED_HEADERS[7]] = nums[2];
        row[CLNBIS_RESERVED_HEADERS[8]] = nums[3];
        row[CLNBIS_RESERVED_HEADERS[13]] = nums[4];
    } else if (nums.length >= 3) {
        row[CLNBIS_RESERVED_HEADERS[1]] = nums[0];
        row[CLNBIS_RESERVED_HEADERS[7]] = nums[1];
        row[CLNBIS_RESERVED_HEADERS[13]] = nums[2];
    }
    return row;
}

function parseClnbisReservedGridRow(gridRow) {
    const items = [...(gridRow.items || [])].sort((a, b) => a.x - b.x);
    const text = String(gridRow.text || '');
    if (!items.length || !ISIN_RE.test(text) || /^ИТОГО\b/i.test(text)) return null;

    const numItems = items.filter((it) => /^\d+$/.test(it.text));
    const firstNumX = numItems[0]?.x ?? Infinity;
    const cb = items
        .filter((it) => it.x < firstNumX - 5)
        .map((it) => it.text)
        .join(' ')
        .trim();

    let nums = numItems.map((it) => it.text);
    if (!nums.length) {
        nums = [...text.matchAll(/\b(\d+)\b/g)].map((m) => m[1]);
    }
    if (!nums.length) return null;

    const row = buildClnbisReservedRow(cb || text, nums);
    return Object.keys(row).length > 1 ? row : null;
}

async function extractClnbisReservedFromBuffer(buffer, allSectionDefs) {
    const reservedDef = (allSectionDefs || []).find((d) => d.id === 'reserved');
    if (!reservedDef || !buffer) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'clnbis_reserved_grid' };
    }

    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const bounds = findSectionBounds(rows, reservedDef, allSectionDefs);
    if (!bounds) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'clnbis_reserved_grid' };
    }

    const parsedRows = [];
    for (const r of rows.slice(bounds.startIdx, bounds.endIdx)) {
        if (/^ИТОГО\b/i.test(r.text)) break;
        const row = parseClnbisReservedGridRow(r);
        if (row) parsedRows.push(row);
    }

    if (!parsedRows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'clnbis_reserved_grid' };
    }

    return {
        ok: true,
        headers: CLNBIS_RESERVED_HEADERS,
        rows: parsedRows,
        confidence: 0.85,
        method: 'clnbis_reserved_grid',
    };
}

function parseForeignReservedLine(line) {
    if (!ISIN_RE.test(line) || line.startsWith(ORGANIZER_PREFIX)) return null;
    const { cb, tail } = splitSecurityAndTail(line);
    if (!cb) return null;

    const nums = [...String(tail || '').matchAll(/(\d{1,3}(?: \d{3})*|\d+)/g)].map((m) => m[1].trim());
    const rubAmounts = extractRuAmounts(tail);

    return rowFromHeaders(H.positions, [
        '',
        cb,
        nums[0] || '',
        nums[1] || nums[0] || '',
        rubAmounts[0] || nums[2] || '',
        rubAmounts[1] || nums[3] || '',
        rubAmounts[2] || '',
    ]);
}

const OPS_GLUE_RE =
    /^(\d{1,3})(\d{2}\.\d{2}\.\d{2})(\d{2}\.\d{2}\.\d{2})?(.+?)(-?\d{1,3}(?: \d{3})*,\d{2})(\d{6,})$/;
const OPS_CASH_GLUE_RE =
    /^(\d{1,3})(\d{2}\.\d{2}\.\d{2})(\d{2}\.\d{2}\.\d{2})(.+?)(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED)(-?\d[\d\s]*,\d{1,2})(-?\d[\d\s]*,\d{1,2})?(\d{6,8})$/i;
const OPS_SINGLE_DATE_RE =
    /^(\d{1,3})(\d{2}\.\d{2}\.\d{2})\s+(.+?)(-?\d{1,3}(?: \d{3})*,\d{2})(\d{6,})$/;
const OPS_DATE_RE = /^\d{2}\.\d{2}\.\d{2}$/;
const OPS_AMOUNT_RE = /^-?\d[\d\s]*,\d{1,2}$/;
const OPS_CURRENCY_RE = /^(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED)$/i;
const OPS_PORTFOLIO_RE = /^\d{6,8}$/;

function parseAtonRuAmount(s) {
    const t = String(s || '').trim().replace(/\s/g, '').replace(',', '.');
    if (!t || !/^-?\d/.test(t)) return s;
    const n = parseFloat(t.replace(/^(-?)0+(?=\d)/, '$1'));
    return Number.isFinite(n) ? n : s;
}

function parseAtonCashOperationsGridRow(gridRow) {
    const items = [...(gridRow.items || [])].sort((a, b) => a.x - b.x);
    if (!items.length || !/^\d+$/.test(items[0].text)) return null;

    const rowNum = items[0].text;
    const dates = items.filter((it) => OPS_DATE_RE.test(it.text));
    const portfolioItem = [...items].reverse().find((it) => OPS_PORTFOLIO_RE.test(it.text));
    const currencyItems = items.filter((it) => OPS_CURRENCY_RE.test(it.text));
    const amountItems = items.filter(
        (it) => OPS_AMOUNT_RE.test(it.text) && it !== portfolioItem
    );

    const skip = new Set([items[0], ...dates, ...currencyItems, ...amountItems, portfolioItem].filter(Boolean));
    const desc = items
        .filter((it) => !skip.has(it))
        .map((it) => it.text)
        .join(' ')
        .trim();

    const rubAmountText =
        amountItems.length >= 2 ? amountItems[amountItems.length - 1].text : amountItems[0]?.text;
    if (!desc || !rubAmountText) return null;

    return rowFromHeaders(H.operations, [
        rowNum,
        dates[0]?.text || '',
        dates[1]?.text || '',
        desc,
        parseAtonRuAmount(rubAmountText),
        portfolioItem?.text || '',
    ]);
}

async function extractAtonCashOperationsFromBuffer(buffer, allSectionDefs) {
    const opsDef = (allSectionDefs || []).find((d) => d.id === 'operations');
    if (!opsDef || !buffer) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_cash_operations_grid' };
    }

    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const bounds = findSectionBounds(rows, opsDef, allSectionDefs);
    if (!bounds) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_cash_operations_grid' };
    }

    const sectionSlice = rows.slice(bounds.startIdx, bounds.endIdx);
    const cashStart = sectionSlice.findIndex((r) =>
        /Операции\s+с\s+денежными\s+средствами/i.test(r.text)
    );
    if (cashStart < 0) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_cash_operations_grid' };
    }

    const parsedRows = [];
    for (const r of sectionSlice.slice(cashStart + 1)) {
        if (/^Страница\s+\d+/i.test(r.text)) break;
        if (/^Распределение\s+денежных\s+средств/i.test(r.text)) break;
        if (/^№\s*п\/п/i.test(r.text) || /Дата\s+принятия/i.test(r.text) || /Дата\s+операции/i.test(r.text)) {
            continue;
        }
        const row = parseAtonCashOperationsGridRow(r);
        if (row) parsedRows.push(row);
    }

    if (!parsedRows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_cash_operations_grid' };
    }

    return {
        ok: true,
        headers: H.operations,
        rows: parsedRows,
        confidence: 0.9,
        method: 'aton_cash_operations_grid',
    };
}

function findTradesDataStart(slice) {
    for (let i = 0; i < slice.length; i++) {
        if (isDataRowText(slice[i].text) || isTradeDataRowAnchor(slice[i].text)) return i;
    }
    return -1;
}

function joinCellParts(...parts) {
    return parts
        .map((p) => String(p ?? '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function shiftCellsLeft(cells, fromIdx) {
    const out = cells.slice();
    for (let i = fromIdx; i < out.length - 1; i++) {
        out[i] = out[i + 1];
    }
    out[out.length - 1] = '';
    return out;
}

function fixRatePriceColumns(cont) {
    if (cont[7] && (/^\d{1,3}$/.test(String(cont[7]).trim()) || /SFAR/i.test(String(cont[6])))) {
        cont[6] = joinCellParts(cont[6], cont[7]);
        cont[7] = '';
    }
    if (!String(cont[7] || '').trim() && /^\d+[,.]\d+$/.test(String(cont[8] || '').trim())) {
        cont[7] = cont[8];
        if (CURRENCY_ONLY_RE.test(String(cont[9] || ''))) {
            cont[8] = cont[9];
            if (CURRENCY_ONLY_RE.test(String(cont[10] || ''))) {
                cont[9] = cont[10];
                cont[10] = '';
            }
        }
    }
    return fixAtonTradesSumAndNkdColumns(cont);
}

function isTradeSumAmount(v) {
    if (typeof v === 'number' && Math.abs(v) >= 1) return true;
    const t = String(v ?? '').trim();
    return /^-?\d{1,3}(?: \d{3})+,\d{2}$/.test(t) || /^-?\d+,\d{2}$/.test(t);
}

function sameTradeAmount(a, b) {
    if (a == null || a === '' || b == null || b === '') return false;
    if (typeof a === 'number' && typeof b === 'number') return a === b;
    const norm = (x) => String(x).replace(/\s/g, '').replace(',', '.');
    return norm(a) === norm(b);
}

function isCommissionGarbage(v) {
    const t = String(v ?? '').trim();
    if (!t || t === '/') return true;
    if (isLikelyCommissionCell(v)) return false;
    if (/^0,\d{2}$/.test(t)) return false;
    return /[а-яё]/i.test(t) || /день|отмен|востреб/i.test(t);
}

/** Комиссия АТОН (x~703) левее биржи (x~757): не оставлять сумму в col 18. */
function fixAtonTradesCommissionColumns(cells) {
    if (isLikelyCommissionCell(cells[18]) && !isLikelyCommissionCell(cells[17])) {
        cells[17] = cells[18];
        cells[18] = '';
    }
    if (isCommissionGarbage(cells[17]) && isLikelyCommissionCell(cells[18])) {
        cells[17] = cells[18];
        cells[18] = '';
    }
    if (isCommissionGarbage(cells[18])) cells[18] = '';
    if (isCommissionGarbage(cells[17])) cells[17] = '';
    return cells;
}

/** После сдвига валют/цены: убрать RUR из «сумма в валюте» и дубль суммы в НКД. */
function fixAtonTradesSumAndNkdColumns(cont) {
    const col10 = String(cont[10] || '').trim();
    if ((!col10 || CURRENCY_ONLY_RE.test(col10)) && isTradeSumAmount(cont[11])) {
        cont[10] = cont[11];
    }
    if (isTradeSumAmount(cont[11]) && sameTradeAmount(cont[11], cont[12])) {
        cont[12] = '';
    }
    if (isTradeSumAmount(cont[11]) && sameTradeAmount(cont[11], cont[13])) {
        cont[13] = '';
    }
    return cont;
}

function isCellEmptyOrPlaceholder(v) {
    const t = String(v ?? '')
        .replace(/\//g, '')
        .trim();
    return !t;
}

function isLikelyCommissionCell(v) {
    const t = String(v ?? '').trim();
    if (!t || t === '/') return false;
    return /^-?\d{1,3}(?: \d{3})*,\d{2}$/.test(t);
}

function mergeAnchorContinuationCells(anchorCells, contCells) {
    const cont = contCells.slice();
    while (cont.length < ATON_TRADES_HEADERS.length) cont.push('');
    const anchor = anchorCells;

    cont[1] = joinCellParts(anchor[1], cont[1]);
    cont[2] = joinCellParts(anchor[2], cont[2]);
    cont[3] = joinCellParts(anchor[3], cont[3]);
    cont[4] = joinCellParts(anchor[4], cont[4]);

    if (anchor[6]) {
        cont[6] = joinCellParts(anchor[6], cont[6]);
    }
    fixRatePriceColumns(cont);

    for (const idx of [13, 16, 18]) {
        const v = String(anchor[idx] || '').trim();
        if (/^\d{2}\.\d{2}\.\d{2}$/.test(v)) {
            const target = idx === 13 ? 14 : idx === 16 ? 16 : null;
            if (target != null && isCellEmptyOrPlaceholder(cont[target])) {
                cont[target] = v;
            }
        }
        if (/^0,\d{2}$/.test(v)) {
            if (isCellEmptyOrPlaceholder(cont[18]) && !isLikelyCommissionCell(cont[18])) cont[18] = v;
            if (isCellEmptyOrPlaceholder(cont[17]) && !isLikelyCommissionCell(cont[17])) cont[17] = v;
        }
    }

    const tpDigit = [19, 20]
        .map((i) => String(anchor[i] || '').trim())
        .find((v) => /^\d+$/.test(v));
    if (tpDigit) {
        const dayPart = String(cont[19] || '')
            .replace(/\//g, ' ')
            .trim();
        cont[19] = joinCellParts(tpDigit, dayPart);
    }

    if (
        /^\/$/.test(String(cont[17] || '').trim()) &&
        /^0,\d{2}$/.test(String(cont[18] || '').trim()) &&
        !isLikelyCommissionCell(cont[18])
    ) {
        cont[17] = cont[18];
    }

    for (const idx of [14, 15, 16, 17, 18, 20]) {
        if (isCellEmptyOrPlaceholder(cont[idx]) && !isCellEmptyOrPlaceholder(anchor[idx])) {
            if ((idx === 17 || idx === 18) && /^0,\d{2}$/.test(String(anchor[idx] || '').trim())) continue;
            cont[idx] = anchor[idx];
        }
    }
    const cont19 = String(cont[19] || '')
        .replace(/\//g, ' ')
        .trim();
    const anchor19 = String(anchor[19] || '')
        .replace(/\//g, ' ')
        .trim();
    if ((!cont19 || /^0,\d{2}$/.test(cont19)) && anchor19 && !/^0,\d{2}$/.test(anchor19)) {
        cont[19] = anchor[19];
    }

    fixAtonTradesCommissionColumns(cont);

    return cont.slice(0, ATON_TRADES_HEADERS.length);
}

function calibrateAtonTradesColumnCenters(regionRows, dataStart) {
    const inferred = inferAdaptiveColumnCenters(regionRows, dataStart, ATON_TRADES_GRID_PROFILE);
    let centers = consolidateColumnCenters(inferred.centers, 9);
    if (centers.length > ATON_TRADES_HEADERS.length) {
        centers = centers.slice(0, ATON_TRADES_HEADERS.length);
    }

    for (let i = dataStart; i < Math.min(dataStart + 80, regionRows.length); i++) {
        const row = regionRows[i];
        if (!isTradeContinuationText(row.text || '') && !isTradeDataRowAnchor(row.text || '')) continue;
        for (const it of row.items || []) {
            if (SMALL_MONEY_RE.test(it.text)) {
                const amt = parseAtonRuAmount(it.text);
                if (
                    amt != null &&
                    Math.abs(amt) > 0 &&
                    Math.abs(amt) < 1_000_000 &&
                    centers.length >= 19 &&
                    it.x > (centers[16] || 0) &&
                    it.x < (centers[19] || 9999)
                ) {
                    centers[17] = it.x;
                }
            }
            if (/АТОН/i.test(it.text) && centers.length >= 18 && it.x > 650 && it.x < 720) {
                centers[17] = Math.max(centers[17] || 0, it.x + 11);
            }
            if (/^биржи$/i.test(it.text) && centers.length >= 19 && it.x > 720 && it.x < 760) {
                centers[18] = it.x + 19;
            }
            if (/^\/$/.test(it.text) && centers.length >= 19) {
                const atonX = centers[17] || 700;
                if (it.x > atonX + 15 && it.x < (centers[19] || 9999)) {
                    centers[18] = it.x;
                }
            }
            if (/^\d{6,8}$/.test(it.text) && centers.length >= 21) {
                centers[20] = it.x;
            }
            if (/^день$/i.test(it.text) && centers.length >= 20) {
                centers[19] = it.x;
            }
        }
    }

    while (centers.length < ATON_TRADES_HEADERS.length) {
        const step =
            centers.length >= 2
                ? centers[centers.length - 1] - centers[centers.length - 2]
                : 40;
        centers.push(centers[centers.length - 1] + step);
    }
    return { centers, xTol: inferred.xTol };
}

function coerceAtonTradesCell(header, value) {
    if (value == null || value === '') {
        if (/комисс/i.test(String(header || ''))) return 0;
        return value;
    }
    const t = String(value).trim();
    if (!t || t === '/') {
        if (/комисс/i.test(String(header || ''))) return 0;
        return '';
    }
    if (CURRENCY_ONLY_RE.test(t)) return t.toUpperCase();
    if (/количество|сумма|цена|нкд|комисс/i.test(String(header || '')) && NUMERIC_CELL_RE.test(t)) {
        return parseAtonRuAmount(t);
    }
    if (NUMERIC_CELL_RE.test(t) && !/[а-яёA-Za-z]{2,}/i.test(t)) {
        return parseAtonRuAmount(t);
    }
    if (/^№\s*п\/п$/i.test(String(header || '').trim()) && /^\d+$/.test(t)) {
        return parseInt(t, 10);
    }
    return t.replace(/\s+/g, ' ').trim();
}

function normalizeAtonTradesCells(cells) {
    const out = [...cells];
    while (out.length < ATON_TRADES_HEADERS.length) out.push('');
    fixAtonTradesSumAndNkdColumns(out);
    fixAtonTradesCommissionColumns(out);
    return out.slice(0, ATON_TRADES_HEADERS.length).map((v, i) => coerceAtonTradesCell(ATON_TRADES_HEADERS[i], v));
}

function parseAtonTradesFromLines(lines, colCenters, xTol) {
    if (!lines?.length) return null;
    const assigned = lines.map((line) => assignItemsToColumns(line, colCenters, xTol));
    let cells;
    if (assigned.length === 1) {
        cells = assigned[0];
    } else {
        cells = assigned[0];
        for (let i = 1; i < assigned.length; i++) {
            cells = mergeAnchorContinuationCells(cells, assigned[i]);
        }
    }
    const values = normalizeAtonTradesCells(cells);
    if (!values.some((v) => v !== '' && v != null)) return null;
    const orgIdx = 1;
    if (values[orgIdx] && !/рынок/i.test(String(values[orgIdx])) && /биржа/i.test(String(values[orgIdx]))) {
        values[orgIdx] = String(values[orgIdx]).replace(/,\s*$/, '') + ', Фондовый рынок';
    }
    const dealIdx = 2;
    if (values[dealIdx] && /mcxs\d+/i.test(String(values[dealIdx]))) {
        values[dealIdx] = String(values[dealIdx])
            .replace(/\s+/g, ' ')
            .replace(/,\s*$/, '')
            .trim();
    }
    return rowFromHeaders(ATON_TRADES_HEADERS, values);
}

function parseAtonTradesGridRow(lines, colCenters, xTol) {
    return parseAtonTradesFromLines(lines, colCenters, xTol);
}

async function extractAtonTradesFromBuffer(buffer, allSectionDefs) {
    const tradesDef = (allSectionDefs || []).find((d) => d.id === 'trades');
    if (!tradesDef || !buffer) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_trades_grid' };
    }

    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const bounds = findSectionBounds(rows, tradesDef, allSectionDefs);
    if (!bounds) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_trades_grid' };
    }

    const slice = rows.slice(bounds.startIdx, bounds.endIdx);
    const dataStart = findTradesDataStart(slice);
    if (dataStart < 0) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_trades_grid' };
    }

    const { centers: colCenters, xTol } = calibrateAtonTradesColumnCenters(slice, dataStart);
    const parsedRows = [];
    let pendingLines = [];

    const flushPending = () => {
        if (!pendingLines.length) return;
        const row = parseAtonTradesFromLines(pendingLines, colCenters, xTol);
        if (row) parsedRows.push(row);
        pendingLines = [];
    };

    for (const r of slice.slice(dataStart)) {
        const text = r.text || '';
        if (/^Исполненные\s+сделки$/i.test(text) || /^Неисполненные\s+сделки$/i.test(text)) continue;
        if (/^Страница\s+\d+/i.test(text)) continue;

        if (isTradeDataRowAnchor(text)) {
            flushPending();
            pendingLines = [r];
            continue;
        }
        if (isTradeContinuationText(text) && pendingLines.length) {
            pendingLines.push(r);
            continue;
        }
        if (pendingLines.length) {
            flushPending();
        }
        if (isDataRowText(text) || isTradeDataRowAnchor(text)) {
            pendingLines = [r];
        }
    }
    flushPending();

    if (!parsedRows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_trades_grid' };
    }

    return {
        ok: true,
        headers: ATON_TRADES_HEADERS,
        rows: parsedRows,
        confidence: 0.92,
        method: 'aton_trades_grid',
        meta: { columns: colCenters.length, columnCenters: colCenters, xTol },
    };
}

function parseOperationsLine(line) {
    const t = String(line || '').trim();
    if (!t || /^№\s*п\/п/i.test(t) || /^Оплата\s+услуг/i.test(t)) return null;

    let m = t.match(OPS_CASH_GLUE_RE);
    if (m) {
        const rubAmount = m[7] || m[6];
        return rowFromHeaders(H.operations, [
            m[1],
            m[2],
            m[3],
            m[4].trim(),
            parseAtonRuAmount(rubAmount),
            m[8].trim(),
        ]);
    }

    m = t.match(OPS_GLUE_RE);
    if (m) {
        const desc = String(m[4] || '')
            .replace(/(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED).+$/i, '')
            .trim();
        return rowFromHeaders(H.operations, [
            m[1],
            m[2],
            m[3] || '',
            desc,
            parseAtonRuAmount(m[5]),
            m[6].trim(),
        ]);
    }

    m = t.match(OPS_SINGLE_DATE_RE);
    if (m) {
        const desc = String(m[3] || '')
            .replace(/(RUR|USD|EUR|CNY|HKD|GBP|CHF|AED).+$/i, '')
            .trim();
        return rowFromHeaders(H.operations, [m[1], m[2], '', desc, parseAtonRuAmount(m[4]), m[5].trim()]);
    }

    return null;
}

function extractAtonOperations(lines) {
    const clean = stripAtonPageNoise(lines);
    const rows = [];
    for (const line of clean) {
        if (/^Страница\s+\d+/i.test(line)) break;
        const row = parseOperationsLine(line);
        if (row) rows.push(row);
    }
    return makeResult(H.operations, rows, 'aton_operations');
}

function parseClnbisOperationsGridRow(gridRow) {
    const items = [...(gridRow.items || [])].sort((a, b) => a.x - b.x);
    if (!items.length || !/^\d+$/.test(items[0].text)) return null;

    const rowNum = items[0].text;
    const dates = items.filter((it) => OPS_DATE_RE.test(it.text));
    const amountItem = items.find((it) => OPS_AMOUNT_RE.test(it.text));
    const portfolioItem = items.find((it) => OPS_PORTFOLIO_RE.test(it.text) && it !== amountItem);

    const skip = new Set([items[0], ...dates, amountItem, portfolioItem].filter(Boolean));
    const desc = items
        .filter((it) => !skip.has(it))
        .map((it) => it.text)
        .join(' ')
        .trim();

    if (!amountItem) return null;

    return rowFromHeaders(H.operations, [
        rowNum,
        dates[0]?.text || '',
        dates[1]?.text || '',
        desc,
        amountItem.text,
        portfolioItem?.text || '',
    ]);
}

async function extractClnbisOperationsFromBuffer(buffer, allSectionDefs) {
    const opsDef = (allSectionDefs || []).find((d) => d.id === 'operations');
    if (!opsDef || !buffer) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'clnbis_operations_grid' };
    }

    const { items } = await extractTextItems(buffer);
    const rows = clusterRows(items);
    const bounds = findSectionBounds(rows, opsDef, allSectionDefs);
    if (!bounds) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'clnbis_operations_grid' };
    }

    const parsedRows = [];
    for (const r of rows.slice(bounds.startIdx, bounds.endIdx)) {
        if (/^Страница\s+\d+/i.test(r.text) || /^№\s*п\/п/i.test(r.text)) continue;
        const row = parseClnbisOperationsGridRow(r);
        if (row) parsedRows.push(row);
    }

    if (!parsedRows.length) {
        return { ok: false, headers: [], rows: [], confidence: 0, method: 'clnbis_operations_grid' };
    }

    return {
        ok: true,
        headers: H.operations,
        rows: parsedRows,
        confidence: 0.88,
        method: 'clnbis_operations_grid',
    };
}

function extractAtonEncumbered(lines) {
    const clean = stripAtonPageNoise(lines);
    const rows = [];
    for (const line of clean) {
        if (/^ИТОГО\b/i.test(line)) break;
        const row = parseAtonEncumberedLine(line);
        if (row) rows.push(row);
    }
    return makeResult(H.encumbered, rows, 'aton_encumbered');
}

function extractAtonTrades(lines) {
    const clean = stripAtonPageNoise(lines);
    const headers = H.trades;
    const rows = [];

    for (let i = 0; i < clean.length; i++) {
        const line = clean[i];
        if (!/RURRUR/.test(line)) continue;

        const amtM = line.match(/RURRUR(-?[\d\s]+,\d{2})/);
        if (!amtM) continue;

        const block = clean.slice(Math.max(0, i - 25), i + 1);
        const blockText = block.join(' ');
        const dealM = blockText.match(DEAL_NO_RE);
        const typeM = blockText.match(DEAL_TYPE_RE);

        let rowNum = '';
        for (let j = block.length - 1; j >= 0; j--) {
            if (/^\d{1,4}$/.test(block[j])) {
                rowNum = block[j];
                break;
            }
        }

        const qtyLine = block.find((b) => /^-?\d[\d\s]{4,}$/.test(b));
        const cbParts = block.filter((b) => ISIN_RE.test(b) || /\(C\)\//.test(b));
        const cbText = cbParts.join(' ').replace(/\s+/g, ' ').trim();

        const exchangeParts = block.filter((b) => /ПАО|Биржа|рынок/i.test(b));
        const exchange = exchangeParts.join(' ').replace(/\s+/g, ' ').trim();

        const dealType = typeM
            ? [typeM[1], typeM[2]].filter(Boolean).join(', ')
            : '';

        const row = rowFromHeaders(headers, [
            rowNum,
            exchange,
            dealM ? dealM[1].replace(/\s+/g, ' ') : '',
            dealType,
            cbText,
            qtyLine || '',
            amtM[1].trim(),
        ]);
        if (row) rows.push(row);
    }

    return makeResult(headers, rows, 'aton_trades');
}

function extractAtonRepo(lines) {
    return extractAtonTrades(lines);
}

function extractAtonSection(sectionId, lines) {
    switch (sectionId) {
        case 'assets':
            return extractAtonAssets(lines);
        case 'reserved':
            return extractAtonReserved(lines);
        case 'encumbered':
            return extractAtonEncumbered(lines);
        case 'repo':
            return extractAtonRepo(lines);
        case 'trades':
            return extractAtonTrades(lines);
        case 'operations':
            return extractAtonOperations(lines);
        default:
            return { ok: false, headers: [], rows: [], confidence: 0, method: 'aton_unknown' };
    }
}

/** @deprecated тесты */
function parseAtonPositionLine(line) {
    return parseAtonReservedLine(line) || parseAtonEncumberedLine(line);
}

module.exports = {
    H,
    ATON_REPORT_HEADER_COLS,
    ATON_REPORT_HEADER_KEYS,
    CLNBIS_RESERVED_HEADERS,
    stripAtonPageNoise,
    parseAtonReportHeader,
    parseBrokerReportHeader: parseAtonReportHeader,
    applyAtonReportHeader,
    applyBrokerReportHeader: applyAtonReportHeader,
    BROKER_REPORT_HEADER_COLS: ATON_REPORT_HEADER_COLS,
    BROKER_REPORT_HEADER_KEYS: ATON_REPORT_HEADER_KEYS,
    normalizeAtonContractValue,
    extractAtonSection,
    extractAtonAssets,
    extractAtonReserved,
    extractAtonEncumbered,
    extractAtonTrades,
    extractAtonRepo,
    extractAtonOperations,
    extractAtonCashOperationsFromBuffer,
    extractAtonTradesFromBuffer,
    extractClnbisReservedFromBuffer,
    extractClnbisOperationsFromBuffer,
    parseClnbisReservedGridRow,
    parseClnbisOperationsGridRow,
    parseAtonCashOperationsGridRow,
    parseAtonTradesGridRow,
    parseAtonTradesFromLines,
    mergeAnchorContinuationCells,
    calibrateAtonTradesColumnCenters,
    ATON_TRADES_HEADERS,
    parseAtonRuAmount,
    parseForeignReservedLine,
    parseGluedAssetsLine,
    parseOperationsLine,
    parseAtonPositionLine,
    parseAtonReservedLine,
    parseAtonEncumberedLine,
    splitSecurityAndTail,
    extractRuAmounts,
};
