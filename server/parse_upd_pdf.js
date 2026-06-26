const pdfParse = require('pdf-parse');
const { probePdfKind } = require('./pdf_probe');

const PRODUCT_CODE_RE = /^\d{6,8}$/;
const QTY_LINE_RE = /[—\-–]796шт/;
const VAT_LINE_RE = /^(\d+)%(\d+),(\d{2})(\d+),(\d{2})/;
const TOTALS_RE = /Всего к оплате \(9\)(\d+),(\d{2})X(\d+),(\d{2})(\d+),(\d{2})/;
const UPD_NUMBER_RE = /Счет-фактура\s+No\s*(\d+)/i;
const UPD_DATE_RE = /от\s*"?(\d{1,2})"?\s*([а-яё]+)\s*(\d{4})/i;

const DOC_HEADER_COLUMNS = [
    { key: 'upd_number', header: 'УПД №' },
    { key: 'upd_date', header: 'УПД дата' },
    { key: 'status', header: 'Статус' },
    { key: 'seller', header: 'Продавец' },
    { key: 'seller_address', header: 'Адрес продавца' },
    { key: 'seller_inn_kpp', header: 'ИНН/КПП продавца' },
    { key: 'consignee', header: 'Грузополучатель' },
    { key: 'buyer', header: 'Покупатель' },
    { key: 'buyer_address', header: 'Адрес покупателя' },
    { key: 'buyer_inn_kpp', header: 'ИНН/КПП покупателя' },
    { key: 'currency', header: 'Валюта' },
    { key: 'edi_provider', header: 'ЭДО' },
];

function toNum(val) {
    if (val == null || val === '') return null;
    const s = String(val).replace(/\s/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function cleanFieldValue(value) {
    return String(value || '')
        .replace(/\(\d+[а-яa-z]?\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function isStructuralLabel(line) {
    const v = String(line || '').trim();
    if (!v) return true;
    if (/^\(\d+[а-яa-z]?\)$/.test(v)) return true;
    return [
        'Адрес',
        'Продавец',
        'Покупатель',
        'ИНН/КПП продавца',
        'ИНН/КПП покупателя',
        'Грузоотправитель и его адрес',
        'Грузополучатель и его адрес',
        'К платежно-расчетному документу',
        'Документ об отгрузке',
        'Валюта: наименование, код',
    ].includes(v);
}

function valueAfterLabel(lines, labelRe, offset = 1) {
    for (let i = 0; i < lines.length; i++) {
        if (!labelRe.test(lines[i])) continue;
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            const v = lines[j];
            if (!v || isStructuralLabel(v) || v === '—') continue;
            return cleanFieldValue(v);
        }
        const fallback = lines[i + offset];
        return fallback && !isStructuralLabel(fallback) ? cleanFieldValue(fallback) : '';
    }
    return '';
}

function addressAfterParty(lines, partyLabel) {
    const partyIdx = lines.findIndex((l) => l === partyLabel);
    if (partyIdx < 0) return '';
    const addrIdx = lines.findIndex((l, i) => i > partyIdx && l === 'Адрес');
    if (addrIdx < 0) return '';
    const parts = [];
    for (let i = addrIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line === '—' || /^\(\d/.test(line)) break;
        if (isStructuralLabel(line)) break;
        parts.push(cleanFieldValue(line));
    }
    return parts.join(' ').trim();
}

function parseGluedQtyLine(line) {
    const prefix = String(line).match(/[—\-–]796шт(.+)$/);
    if (!prefix) return null;
    const rest = prefix[1].replace(/\s/g, '');
    const m = rest.match(/^(\d+),(\d{2})(\d+),(\d{2})$/);
    if (!m) return null;

    const gluedQtyPrice = m[1];
    const priceKop = m[2];
    const amountRub = m[3];
    const amountKop = m[4];
    const amount_net = toNum(`${amountRub}.${amountKop}`);
    if (amount_net == null) return null;

    if (amount_net === 0 && /^\d+$/.test(gluedQtyPrice)) {
        return {
            qty: toNum(gluedQtyPrice),
            price: 0,
            amount_net: 0,
            unit: 'шт',
            unit_code: '796',
        };
    }

    for (let prLen = 1; prLen <= 5; prLen++) {
        const priceRub = gluedQtyPrice.slice(-prLen);
        const qtyPart = gluedQtyPrice.slice(0, -prLen);
        const qty = toNum(qtyPart);
        const price = toNum(`${priceRub}.${priceKop}`);
        if (qty == null || price == null || qty <= 0 || price <= 0) continue;
        if (Math.abs(qty * price - amount_net) < 1.5) {
            return { qty, price, amount_net, unit: 'шт', unit_code: '796' };
        }
    }
    return { qty: toNum(gluedQtyPrice), price: null, amount_net, unit: 'шт', unit_code: '796' };
}

function parseVatLine(line) {
    const s = String(line || '');
    if (/без\s*НДС/i.test(s)) {
        const m = s.match(/(\d+),(\d{2})/);
        return {
            vat_rate: 'без НДС',
            vat_amount: 0,
            amount_gross: m ? toNum(`${m[1]}.${m[2]}`) : 0,
        };
    }
    const m = s.match(VAT_LINE_RE);
    if (!m) return null;
    return {
        vat_rate: `${m[1]}%`,
        vat_amount: toNum(`${m[2]}.${m[3]}`),
        amount_gross: toNum(`${m[4]}.${m[5]}`),
    };
}

function parseTotals(lines) {
    for (const line of lines) {
        const m = line.match(TOTALS_RE);
        if (!m) continue;
        return {
            amount_net_total: toNum(`${m[1]}.${m[2]}`),
            vat_total: toNum(`${m[3]}.${m[4]}`),
            amount_gross_total: toNum(`${m[5]}.${m[6]}`),
        };
    }
    return null;
}

function parseDocHeader(lines) {
    const joined = lines.join('\n');
    const numM = joined.match(UPD_NUMBER_RE);
    const dateM = joined.match(UPD_DATE_RE);
    return {
        upd_number: numM ? numM[1] : '',
        upd_date: dateM ? `${dateM[1]} ${dateM[2]} ${dateM[3]}` : '',
        status: /Статус:\s*(\S+)/.exec(joined)?.[1] || '',
        seller: valueAfterLabel(lines, /^Продавец$/),
        seller_address: addressAfterParty(lines, 'Продавец'),
        seller_inn_kpp: valueAfterLabel(lines, /^ИНН\/КПП продавца$/),
        consignee: valueAfterLabel(lines, /^Грузополучатель и его адрес$/),
        buyer: valueAfterLabel(lines, /^Покупатель$/),
        buyer_address: addressAfterParty(lines, 'Покупатель'),
        buyer_inn_kpp: valueAfterLabel(lines, /^ИНН\/КПП покупателя$/),
        currency: valueAfterLabel(lines, /^Валюта: наименование, код$/),
        edi_provider: /Передано через\s+(\S+)/i.exec(joined)?.[1] || '',
    };
}

function parseLineItems(lines) {
    const items = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        const glued = line.match(/^(\d{6,8})(.+—796шт.+)$/);
        if (glued) {
            const qty = parseGluedQtyLine(glued[2]);
            let vat = null;
            for (let k = i + 1; k < Math.min(i + 6, lines.length); k++) {
                vat = parseVatLine(lines[k]);
                if (vat) break;
            }
            items.push({
                line_no: items.length + 1,
                product_code: glued[1],
                name: glued[2].split(/[—\-–]796шт/)[0].trim(),
                ...qty,
                ...vat,
            });
            i++;
            continue;
        }

        if (PRODUCT_CODE_RE.test(line)) {
            const nameParts = [];
            let j = i + 1;
            while (j < lines.length && !QTY_LINE_RE.test(lines[j]) && !PRODUCT_CODE_RE.test(lines[j])) {
                if (!/^без$/i.test(lines[j]) && !/^акциза$/i.test(lines[j]) && lines[j] !== '—————') {
                    nameParts.push(lines[j]);
                }
                j++;
            }
            const qtyLine = lines[j];
            if (!qtyLine || !QTY_LINE_RE.test(qtyLine)) {
                i++;
                continue;
            }
            const qty = parseGluedQtyLine(qtyLine);
            let vat = null;
            for (let k = j + 1; k < Math.min(j + 6, lines.length); k++) {
                vat = parseVatLine(lines[k]);
                if (vat) break;
            }
            items.push({
                line_no: items.length + 1,
                product_code: line,
                name: nameParts.join(' ').trim(),
                ...qty,
                ...vat,
            });
            i = j + 1;
            continue;
        }

        i++;
    }
    return items;
}

function buildLineItemHeaders() {
    return [
        ...DOC_HEADER_COLUMNS.map((c) => c.header),
        '№',
        'Код товара',
        'Наименование',
        'Ед.',
        'Кол-во',
        'Цена',
        'Сумма без НДС',
        'Ставка НДС',
        'Сумма НДС',
        'Сумма с НДС',
    ];
}

function lineItemsToRows(items, doc_header = {}) {
    const headerFields = {};
    for (const col of DOC_HEADER_COLUMNS) {
        headerFields[col.header] = doc_header[col.key] ?? '';
    }
    return items.map((it) => ({
        ...headerFields,
        '№': it.line_no,
        'Код товара': it.product_code || '',
        Наименование: it.name || '',
        'Ед.': it.unit || '',
        'Кол-во': it.qty ?? '',
        Цена: it.price ?? '',
        'Сумма без НДС': it.amount_net ?? '',
        'Ставка НДС': it.vat_rate || '',
        'Сумма НДС': it.vat_amount ?? '',
        'Сумма с НДС': it.amount_gross ?? '',
    }));
}

function parseUpdFromLines(lines) {
    const doc_header = parseDocHeader(lines);
    const line_items = parseLineItems(lines);
    const totals = parseTotals(lines);
    const headers = buildLineItemHeaders();
    const rows = lineItemsToRows(line_items, doc_header);
    return {
        ok: line_items.length > 0,
        scenarioId: 'upd_ediweb',
        doc_header,
        totals,
        line_items,
        headers,
        rows,
    };
}

async function parseUpdPdf(buffer, fileName = '') {
    const probe = await probePdfKind(buffer);
    if (probe.kind !== 'upd_ediweb' && probe.kind !== 'unknown') {
        return null;
    }
    const lines = probe.lines || [];
    const parsed = parseUpdFromLines(lines);
    if (!parsed.ok) return null;
    parsed.fileName = fileName;
    return parsed;
}

function validateUpdParse(parsed) {
    if (!parsed?.rows?.length) return false;
    if (parsed.totals?.amount_net_total != null && parsed.line_items?.length) {
        const sumNet = parsed.line_items.reduce((s, r) => s + (r.amount_net || 0), 0);
        const diff = Math.abs(sumNet - parsed.totals.amount_net_total);
        if (diff > 1 && diff / parsed.totals.amount_net_total > 0.02) return false;
    }
    if (parsed.totals?.amount_gross_total != null && parsed.line_items?.length) {
        const sumGross = parsed.line_items.reduce((s, r) => s + (r.amount_gross || 0), 0);
        const diff = Math.abs(sumGross - parsed.totals.amount_gross_total);
        if (diff > 1 && diff / parsed.totals.amount_gross_total > 0.02) return false;
    }
    return true;
}

async function importUpdParseToSnapshot(pool, { file, projectId, parsed }) {
    const { createParseSnapshotStore } = require('./parse_snapshot_store');
    const store = createParseSnapshotStore(pool);
    const sid = await store.createSnapshot({
        projectId: projectId ? parseInt(projectId, 10) : null,
        sourceFileName: file.originalname,
        sheetName: null,
        scenarioId: parsed.scenarioId,
        headers: parsed.headers,
        status: 'parsing',
    });
    const rowCount = await store.importParsedRows(sid, parsed.headers, parsed.rows);
    return {
        ok: true,
        snapshotId: sid,
        parsePreview: {
            headers: parsed.headers,
            rows: parsed.rows.slice(0, 200),
            rowCount,
        },
        meta: { doc_header: parsed.doc_header, totals: parsed.totals },
        warnings: [],
    };
}

async function tryParseUpdPdf({ pool, file, projectId }) {
    const parsed = await parseUpdPdf(file.buffer, file.originalname || '');
    if (!parsed?.rows?.length) return null;
    if (!validateUpdParse(parsed)) {
        return {
            ok: false,
            error: 'УПД распознан с предупреждением: суммы строк не сходятся с итогом',
            parsePreview: { headers: parsed.headers, rows: parsed.rows.slice(0, 50), rowCount: parsed.rows.length },
            needsConfirm: true,
        };
    }
    const imported = await importUpdParseToSnapshot(pool, { file, projectId, parsed });
    if (!imported.ok) return null;
    return {
        ok: true,
        scenarioId: parsed.scenarioId,
        scenarioName: 'УПД (Эдивеб)',
        snapshotId: imported.snapshotId,
        rowCount: imported.parsePreview.rowCount,
        parsePreview: imported.parsePreview,
        meta: imported.meta,
        warnings: imported.warnings,
        needsConfirm: false,
        assistantMessage: `УПД **${parsed.doc_header.upd_number || '—'}**: **${imported.parsePreview.rowCount}** позиций (плоская таблица с шапкой).`,
    };
}

module.exports = {
    parseUpdFromLines,
    parseUpdPdf,
    validateUpdParse,
    tryParseUpdPdf,
    parseGluedQtyLine,
    parseVatLine,
    parseTotals,
    DOC_HEADER_COLUMNS,
};
