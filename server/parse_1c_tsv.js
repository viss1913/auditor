/**
 * Парсер текстовых выгрузок 1С (TSV/«CSV» в .txt): кавычки, переносы в ячейках.
 */

let iconvLite;
function getIconv() {
    if (!iconvLite) {
        try {
            iconvLite = require('iconv-lite');
        } catch {
            iconvLite = null;
        }
    }
    return iconvLite;
}

function decode1cText(source) {
    if (!Buffer.isBuffer(source)) {
        return { text: String(source || ''), encoding: 'utf8' };
    }

    const utf8 = source.toString('utf8');
    if (utf8.includes('Период') && utf8.includes('Документ')) {
        return { text: utf8, encoding: 'utf8' };
    }

    const iconv = getIconv();
    if (iconv) {
        for (const enc of ['win1251', 'cp866']) {
            const text = iconv.decode(source, enc);
            if (text.includes('Период') && text.includes('Документ')) {
                return { text, encoding: enc };
            }
        }
    }

    return { text: utf8, encoding: 'utf8' };
}

const HEADERS_CARD_90 = [
    'Период',
    'Документ',
    'Контрагент',
    'ID сделки',
    'Инструмент',
    'Аналитика Дт',
    'Аналитика Кт',
    'Счёт Дт',
    'Сумма Дт',
    'Счёт Кт',
    'Сумма Кт',
];

const HEADERS_DEALS_REGISTRY = [
    'Дата сделки',
    'Номер сделки',
    'Контрагент',
    'Инструмент',
    'Количество',
    'Сумма',
    'Валюта',
    'Комментарий',
];

function parseTsvRecords(text, delimiter = '\t') {
    const records = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];

        if (inQuotes) {
            if (c === '"' && next === '"') {
                field += '"';
                i++;
            } else if (c === '"') {
                inQuotes = false;
            } else {
                field += c;
            }
            continue;
        }

        if (c === '"') {
            inQuotes = true;
        } else if (c === delimiter) {
            row.push(field);
            field = '';
        } else if (c === '\n' || (c === '\r' && next === '\n')) {
            row.push(field);
            field = '';
            if (row.some((cell) => String(cell).trim() !== '')) records.push(row);
            row = [];
            if (c === '\r') i++;
        } else if (c !== '\r') {
            field += c;
        }
    }

    if (field.length || row.length) {
        row.push(field);
        if (row.some((cell) => String(cell).trim() !== '')) records.push(row);
    }

    return records;
}

function normalizeCell(raw) {
    return String(raw ?? '')
        .replace(/\u00A0/g, ' ')
        .replace(/\r\n/g, '\n')
        .trim();
}

function parseAmount(raw) {
    const s = normalizeCell(raw).replace(/\s/g, '').replace(',', '.');
    if (!s || s === '-') return null;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function firstLine(text) {
    return normalizeCell(text).split('\n').find((l) => l.trim()) || '';
}

function extractDealId(document, analyticsDt) {
    const blob = `${document}\n${analyticsDt}`;
    const m =
        blob.match(/Сделка\s*\(ат\)\s*(\d+)/i) ||
        blob.match(/Продажа\s+ЦБ\s+(\d+)/i) ||
        blob.match(/SOSO-(\d+)/i);
    return m ? m[1] : '';
}

function extractInstrument(analyticsKt) {
    const lines = normalizeCell(analyticsKt)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    if (!lines.length) return '';
    return lines[lines.length - 1];
}

function detectProfile(preambleText) {
    if (/отчет\s+по\s+проводкам/i.test(preambleText) && /90\.01/i.test(preambleText)) {
        return 'card_90_tsv';
    }
    if (/реестр\s+сделок/i.test(preambleText)) {
        return 'deals_registry_tsv';
    }
    return 'generic_1c_tsv';
}

function findHeaderIndex(records) {
    for (let i = 0; i < records.length; i++) {
        const c0 = normalizeCell(records[i][0]);
        if (c0 === 'Период' && normalizeCell(records[i][1]) === 'Документ') return i;
    }
    return -1;
}

function findDealsHeaderIndex(records) {
    for (let i = 0; i < records.length; i++) {
        const row = records[i].map((c) => normalizeCell(c).toLowerCase());
        const hasDate = row.some((c) => /дата/.test(c));
        const hasDealNo = row.some((c) => /номер\s*сделк|№\s*сделк|id\s*сделк/i.test(c));
        if (hasDate && hasDealNo) return i;
    }
    return -1;
}

function buildColumnMap(headerRow) {
    const map = {};
    headerRow.forEach((cell, idx) => {
        const key = normalizeCell(cell).toLowerCase();
        if (!key) return;
        if (/^дата/.test(key)) map.date = idx;
        else if (/номер\s*сделк|№\s*сделк|id\s*сделк/i.test(key)) map.dealId = idx;
        else if (/контрагент/i.test(key)) map.counterparty = idx;
        else if (/инструмент|ценн|бумаг|актив/i.test(key)) map.instrument = idx;
        else if (/колич/i.test(key)) map.quantity = idx;
        else if (/сумм/i.test(key)) map.amount = idx;
        else if (/валют/i.test(key)) map.currency = idx;
        else if (/коммент/i.test(key)) map.comment = idx;
    });
    return map;
}

function mapDealsRegistryRow(row, colMap) {
    const date = normalizeCell(row[colMap.date]);
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(date)) return null;
    const dealId = normalizeCell(row[colMap.dealId]);
    if (!dealId) return null;

    return {
        'Дата сделки': date,
        'Номер сделки': dealId,
        Контрагент: colMap.counterparty != null ? firstLine(row[colMap.counterparty]) : '',
        Инструмент: colMap.instrument != null ? firstLine(row[colMap.instrument]) : '',
        Количество: colMap.quantity != null ? parseAmount(row[colMap.quantity]) : null,
        Сумма: colMap.amount != null ? parseAmount(row[colMap.amount]) : null,
        Валюта: colMap.currency != null ? normalizeCell(row[colMap.currency]) : '',
        Комментарий: colMap.comment != null ? normalizeCell(row[colMap.comment]) : '',
    };
}

function mapCard90Row(row) {
    const period = normalizeCell(row[0]);
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(period)) return null;

    const document = normalizeCell(row[1]);
    const analyticsDt = normalizeCell(row[2]);
    const analyticsKt = normalizeCell(row[3]);
    const accountDt = normalizeCell(row[4]);
    const amountDt = parseAmount(row[5]);
    const accountKt = normalizeCell(row[7]);
    const amountKt = parseAmount(row[8]);

    return {
        Период: period,
        Документ: document,
        Контрагент: firstLine(analyticsDt),
        'ID сделки': extractDealId(document, analyticsDt),
        Инструмент: extractInstrument(analyticsKt),
        'Аналитика Дт': analyticsDt,
        'Аналитика Кт': analyticsKt,
        'Счёт Дт': accountDt,
        'Сумма Дт': amountDt,
        'Счёт Кт': accountKt,
        'Сумма Кт': amountKt,
    };
}

/**
 * @param {string|Buffer} source
 * @param {{ fileName?: string }} [options]
 */
function parse1cTsvExport(source, options = {}) {
    const { text, encoding } = decode1cText(
        Buffer.isBuffer(source) ? source : Buffer.from(String(source || ''), 'utf8')
    );
    const warnings = [];
    if (encoding !== 'utf8') {
        warnings.push(`Кодировка файла: ${encoding} (автоопределение)`);
    }
    const records = parseTsvRecords(text);
    const preamble = records
        .slice(0, 12)
        .map((r) => r.join(' '))
        .join('\n');
    const profile = detectProfile(preamble);

    if (profile === 'deals_registry_tsv') {
        const dealsHeaderIdx = findDealsHeaderIndex(records);
        if (dealsHeaderIdx < 0) {
            return {
                ok: false,
                errors: ['Не найдена шапка реестра сделок (ожидали Дата + Номер сделки)'],
                profile,
                fileName: options.fileName || null,
            };
        }
        const colMap = buildColumnMap(records[dealsHeaderIdx]);
        if (colMap.date == null || colMap.dealId == null) {
            return {
                ok: false,
                errors: ['В шапке реестра сделок не найдены колонки Дата и Номер сделки'],
                profile,
                fileName: options.fileName || null,
            };
        }
        const dataRows = records.slice(dealsHeaderIdx + 1);
        const rows = [];
        for (const row of dataRows) {
            const mapped = mapDealsRegistryRow(row, colMap);
            if (mapped) rows.push(mapped);
        }
        if (!rows.length) {
            return {
                ok: false,
                errors: ['После шапки реестра не найдено строк с датой и номером сделки'],
                profile,
                fileName: options.fileName || null,
                rawRecordCount: records.length,
            };
        }
        return {
            ok: true,
            profile,
            fileName: options.fileName || null,
            headers: HEADERS_DEALS_REGISTRY,
            rows,
            rowCount: rows.length,
            warnings,
            meta: {
                entity: firstLine(records[0]?.[0] || ''),
                reportTitle: records[1]?.[0] || '',
                physicalRecords: records.length,
                logicalRows: rows.length,
                encoding,
            },
        };
    }

    const headerIdx = findHeaderIndex(records);
    if (headerIdx < 0) {
        return {
            ok: false,
            errors: ['Не найдена шапка таблицы (ожидали колонки Период, Документ…)'],
            profile,
            fileName: options.fileName || null,
        };
    }

    const dataRows = records.slice(headerIdx + 2);
    const rows = [];
    for (const row of dataRows) {
        const mapped = mapCard90Row(row);
        if (mapped) rows.push(mapped);
    }

    if (!rows.length) {
        return {
            ok: false,
            errors: ['После шапки не найдено ни одной строки с датой в колонке Период'],
            profile,
            fileName: options.fileName || null,
            rawRecordCount: records.length,
        };
    }

    if (profile === 'generic_1c_tsv') {
        warnings.push('Формат распознан как generic_1c_tsv; применена схема card_90');
    }

    return {
        ok: true,
        profile,
        fileName: options.fileName || null,
        headers: HEADERS_CARD_90,
        rows,
        rowCount: rows.length,
        warnings,
        meta: {
            entity: firstLine(records[0]?.[0] || ''),
            reportTitle: records[1]?.[0] || '',
            filterLine: records.find((r) => /отбор:/i.test(String(r[0])))?.[0] || '',
            physicalRecords: records.length,
            logicalRows: rows.length,
            encoding,
        },
    };
}

module.exports = {
    parse1cTsvExport,
    parseTsvRecords,
    detectProfile,
    decode1cText,
    HEADERS_CARD_90,
    HEADERS_DEALS_REGISTRY,
    findDealsHeaderIndex,
    mapDealsRegistryRow,
};
