const xlsx = require('xlsx');
const { isBrokerLlmProbeEnabled } = require('./martin_flags');

function isBrokerSection12Start(rowText) {
    const t = String(rowText || '').toLowerCase();
    if (!t.includes('1.2') && !/\b1\s*[\.\-]\s*2\b/.test(t)) return false;
    if (!t.includes('сделк')) return false;
    return (
        t.includes('не исполн') ||
        t.includes('ожида') ||
        t.includes('открыт') ||
        t.includes('на отчет') ||
        t.includes('на отчётную')
    );
}

function isBrokerSection11Start(rowText) {
    const t = String(rowText || '').toLowerCase();
    if (!t.includes('1.1') && !/\b1\s*[\.\-]\s*1\b/.test(t)) return false;
    if (!t.includes('сделк')) return false;
    return t.includes('прекращ') || (t.includes('исполн') && !t.includes('не исполн'));
}

function isBrokerSectionStart(rowText, sectionId = '1.2') {
    return sectionId === '1.1' ? isBrokerSection11Start(rowText) : isBrokerSection12Start(rowText);
}

function brokerSectionTitleHead(rowSlice = '', rowText = '') {
    const raw = String(rowSlice || rowText || '').trim().toLowerCase();
    if (!raw) return '';
    const firstCell = raw.split(/\s{2,}/)[0]?.trim() || raw;
    return firstCell.slice(0, 160);
}

function isBrokerRowEmpty(row) {
    if (!Array.isArray(row)) return true;
    return row.every((c) => !String(c ?? '').trim());
}

function isBrokerTableHeaderRow(row) {
    if (!Array.isArray(row)) return false;
    let hasTradeDate = false;
    let hasOp = false;
    for (const cell of row) {
        const t = normalizeHeaderCell(cell);
        if (t.includes('дата и время сделки')) hasTradeDate = true;
        if (t === 'вид сделки' || t.startsWith('вид сделки')) hasOp = true;
    }
    return hasTradeDate || hasOp;
}

/** Заголовок подраздела 1.3+ или «Раздел 2» в первой ячейке. */
function isBrokerLaterSectionStart(rowText, rowSlice = '') {
    const head = brokerSectionTitleHead(rowSlice, rowText);
    if (!head) return false;
    if (/^1\s*[\.\-]\s*[3-9][\.\s]/.test(head) && head.includes('сделк')) return true;
    if (/^раздел\s*2\b/.test(head) || (head.includes('раздел 2') && head.includes('сделк'))) {
        return true;
    }
    if (/^2\s*[\.\-]\s*\d/.test(head) && (head.includes('раздел') || head.includes('сделк'))) {
        return true;
    }
    return false;
}

/** Конец 1.1/1.2 — заголовок следующего раздела или пустой пропуск после таблицы сделок. */
function isBrokerSectionEnd(rowText, rowSlice = '') {
    return isBrokerLaterSectionStart(rowText, rowSlice);
}

/**
 * Пропуск строк перед следующим блоком: после сделок в отчёте всегда пустые строки.
 * Не срабатывает на пустую строку между заголовком раздела и шапкой таблицы (сделок ещё не было).
 */
function isBrokerSectionGapEnd(data, rowIndex, seenTradeRow) {
    if (!seenTradeRow || !isBrokerRowEmpty(data[rowIndex])) return false;
    for (let j = rowIndex + 1; j < Math.min(rowIndex + 5, data.length); j++) {
        const next = data[j];
        if (!Array.isArray(next)) continue;
        if (isBrokerRowEmpty(next)) continue;
        const nextText = next.map((v) => String(v)).join(' ').toLowerCase();
        const slice = next.slice(0, 10).join(' ');
        if (
            isBrokerLaterSectionStart(nextText, slice) ||
            isBrokerSection11Start(nextText) ||
            isBrokerSection12Start(nextText) ||
            isBrokerTableHeaderRow(next)
        ) {
            return true;
        }
        return false;
    }
    return true;
}

function isBrokerSectionEndFor(sectionId, rowText, rowSlice = '') {
    if (sectionId === '1.1' && isBrokerSection12Start(rowText)) return true;
    return isBrokerSectionEnd(rowText, rowSlice);
}

function normalizeHeaderCell(val) {
    return String(val || '')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function findBrokerHeaderMap(data, fromRow) {
    const map = {};
    const end = Math.min((fromRow || 0) + 8, (data || []).length);
    for (let i = fromRow; i < end; i++) {
        const row = data[i];
        if (!Array.isArray(row)) continue;
        row.forEach((cell, colIdx) => {
            const t = normalizeHeaderCell(cell);
            if (!t) return;
            if (t.includes('% репо')) map.repo_percent = colIdx;
            if (t.includes('номер сделки на бирже')) map.exchange_trade_number = colIdx;
            if (t.includes('коли') && t.includes('цб')) map.quantity = colIdx;
            if (t.includes('сумма сделки') && t.includes('вал')) map.amount = colIdx;
            if (t.includes('валюта сделки')) map.currency = colIdx;
            if (t.includes('дата пере') && t.includes('регистрации')) map.registrationDate = colIdx;
            if (t.includes('брокер') && t.includes('ская')) map.broker_fee = colIdx;
            if (t.includes('дата и время сделки')) map.trade_datetime = colIdx;
            if (t === 'вид сделки' || t.startsWith('вид сделки')) map.operationType = colIdx;
            if (t.includes('ценная бумага')) map.security = colIdx;
        });
    }
    return map;
}

function cellAt(row, idx) {
    if (idx == null || idx < 0 || !Array.isArray(row)) return '';
    const v = row[idx];
    if (v == null || v === '') return '';
    if (v instanceof Date) return v.toLocaleDateString('ru-RU');
    return String(v).replace(/\s+/g, ' ').trim();
}

function parseNumberCell(val) {
    if (val == null || val === '') return 0;
    if (typeof val === 'number') return val;
    const n = parseFloat(String(val).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

function parseBrokerSheet(data, logLabel = '', options = {}) {
    const results = [];
    let inSection = false;
    let columnMap = null;
    let headerScanFrom = null;
    let seenTradeRow = false;
    const forcedStart = options.sectionStartRow;
    const sectionId = options.sectionId === '1.1' ? '1.1' : '1.2';

    if (logLabel) {
        console.log(`--- Парсинг Брокера (v12, секция ${sectionId}) --- Файл: ${logLabel}`);
    }

    const leaveSection = () => {
        inSection = false;
        columnMap = null;
        headerScanFrom = null;
        seenTradeRow = false;
    };

    data.forEach((row, index) => {
        if (!Array.isArray(row)) return;
        if (forcedStart != null && index < forcedStart) return;

        const rowText = row.map((v) => String(v)).join(' ').toLowerCase();

        if (!inSection && isBrokerSectionStart(rowText, sectionId)) {
            inSection = true;
            columnMap = null;
            headerScanFrom = index + 1;
            seenTradeRow = false;
            return;
        }

        if (inSection && isBrokerSectionEndFor(sectionId, rowText, row.slice(0, 10).join(' '))) {
            leaveSection();
            return;
        }

        if (inSection && isBrokerSectionGapEnd(data, index, seenTradeRow)) {
            leaveSection();
            return;
        }

        if (inSection && !columnMap && headerScanFrom != null && index >= headerScanFrom) {
            const candidate = findBrokerHeaderMap(data, headerScanFrom);
            if (candidate.repo_percent != null || candidate.exchange_trade_number != null) {
                columnMap = candidate;
            }
        }

        if (inSection) {
            let dateStr = '';
            let dateIdx = -1;

            for (let i = 0; i < Math.min(row.length, 5); i++) {
                const val = row[i];
                if (!val) continue;
                if (val instanceof Date) {
                    dateStr = val.toLocaleDateString('ru-RU');
                    dateIdx = i;
                    break;
                }
                const sval = String(val).trim();
                const m = sval.match(/^(\d{2}\.\d{2}\.\d{4})/);
                if (m) {
                    dateStr = m[1];
                    dateIdx = i;
                    break;
                }
            }

            if (dateStr && dateIdx !== -1) {
                let operation = '';
                let opIdx = -1;
                for (let i = dateIdx + 1; i < Math.min(dateIdx + 6, row.length); i++) {
                    const val = String(row[i] || '').trim();
                    const valLow = val.toLowerCase();
                    if (valLow.includes('покупка') || valLow.includes('продажа') || valLow.includes('репо')) {
                        operation = val;
                        opIdx = i;
                        break;
                    }
                }

                if (operation && opIdx !== -1) {
                    const longCells = [];
                    for (let i = opIdx + 1; i < row.length; i++) {
                        const val = String(row[i] || '').trim();
                        if (val.length > 3) {
                            longCells.push({
                                val: val.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim(),
                                idx: i,
                            });
                        }
                    }

                    let securityInfo = '';
                    let infoIdx = -1;

                    for (const cell of longCells) {
                        if (
                            /ISIN/i.test(cell.val) ||
                            /[A-Z]{2}[A-Z0-9]{10}/.test(cell.val) ||
                            /\d[\dА-Яа-яA-Za-z]{0,3}-\d{2}-\d{4,6}/.test(cell.val)
                        ) {
                            securityInfo = cell.val;
                            infoIdx = cell.idx;
                            break;
                        }
                    }

                    if (!securityInfo && longCells.length >= 2) {
                        securityInfo = longCells[1].val;
                        infoIdx = longCells[1].idx;
                    }
                    if (!securityInfo && longCells.length === 1) {
                        securityInfo = longCells[0].val;
                        infoIdx = longCells[0].idx;
                    }

                    if (securityInfo) {
                        const isinMatch =
                            securityInfo.match(/ISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})/i) ||
                            securityInfo.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
                        const isin = isinMatch ? isinMatch[1] : '';

                        const regMatch = securityInfo.match(
                            /(\d[\dА-Яа-яA-Za-z]{0,3}-\d{2}-\d{4,6}-[А-ЯA-Z\d-]+)/i
                        );
                        const regMatchShort = !regMatch ? securityInfo.match(/\b(\d{7,9}[A-Z])\b/) : null;
                        const regNum = regMatch ? regMatch[1] : regMatchShort ? regMatchShort[1] : '';
                        const regMatchUsed = regMatch || regMatchShort;

                        let name = securityInfo;
                        if (isinMatch) name = name.split(isinMatch[0])[0];
                        if (regMatchUsed) name = name.replace(regMatchUsed[0], '');
                        name = name.replace(/ISIN/gi, '').replace(/[№\u2116]\s*/g, '').trim();
                        name = name.replace(/[\s,;|]+$/, '').trim();

                        const foundNums = [];
                        for (let i = infoIdx + 1; i < row.length; i++) {
                            const val = row[i];
                            if (typeof val === 'number' && val !== 0) foundNums.push(val);
                            else if (val) {
                                const n = parseFloat(String(val).replace(/\s/g, '').replace(',', '.'));
                                if (!isNaN(n) && n !== 0) foundNums.push(n);
                            }
                        }

                        const quantity = foundNums[0] || 0;
                        const amount = foundNums[3] || foundNums[foundNums.length - 1] || 0;

                        let currency = '';
                        let currencyIdx = -1;
                        for (let i = infoIdx + 1; i < row.length; i++) {
                            if (['RUB', 'USD', 'EUR', 'CNY'].includes(String(row[i]).trim().toUpperCase())) {
                                currency = String(row[i]).trim().toUpperCase();
                                currencyIdx = i;
                                break;
                            }
                        }

                        let registrationDate = '';
                        let regDateIdx = -1;
                        if (currencyIdx !== -1) {
                            for (let i = currencyIdx + 1; i < row.length; i++) {
                                const val = row[i];
                                if (!val) continue;
                                if (val instanceof Date) {
                                    registrationDate = val.toLocaleDateString('ru-RU');
                                    for (let j = i + 1; j < row.length; j++) {
                                        if (
                                            row[j] instanceof Date ||
                                            /^(\d{2}\.\d{2}\.\d{4})/.test(String(row[j]).trim())
                                        ) {
                                            regDateIdx = j;
                                            break;
                                        }
                                    }
                                    if (regDateIdx === -1) regDateIdx = i;
                                    break;
                                }
                                const sval = String(val).trim();
                                const m = sval.match(/^(\d{2}\.\d{2}\.\d{4})/);
                                if (m) {
                                    registrationDate = m[1];
                                    for (let j = i + 1; j < row.length; j++) {
                                        if (
                                            row[j] instanceof Date ||
                                            /^(\d{2}\.\d{2}\.\d{4})/.test(String(row[j]).trim())
                                        ) {
                                            regDateIdx = j;
                                            break;
                                        }
                                    }
                                    if (regDateIdx === -1) regDateIdx = i;
                                    break;
                                }
                            }
                        }

                        let fee = 0;
                        if (columnMap?.broker_fee != null) {
                            fee = parseNumberCell(row[columnMap.broker_fee]);
                        } else if (regDateIdx !== -1) {
                            let totalFee = 0;
                            let feeFound = false;
                            for (let i = regDateIdx + 1; i < row.length; i++) {
                                const val = row[i];
                                if (val === undefined || val === null || val === '') continue;
                                const svalText = String(val).trim().toUpperCase();
                                if (svalText.includes('1F018') || svalText.includes('ПОРТФЕЛЬ')) break;
                                if (
                                    ['RUB', 'USD', 'EUR', 'CNY'].includes(svalText) ||
                                    svalText.includes('РЕПО') ||
                                    svalText.includes('НОМЕР')
                                ) {
                                    continue;
                                }
                                if (typeof val === 'number') {
                                    if (val < 1000000) {
                                        totalFee += val;
                                        feeFound = true;
                                    }
                                } else {
                                    const n = parseFloat(String(val).replace(/\s/g, '').replace(',', '.'));
                                    if (!isNaN(n) && typeof val !== 'boolean' && n < 1000000) {
                                        totalFee += n;
                                        feeFound = true;
                                    }
                                }
                            }
                            if (feeFound) fee = totalFee;
                        }

                        const repoPercent =
                            columnMap?.repo_percent != null
                                ? parseNumberCell(row[columnMap.repo_percent])
                                : '';
                        const exchangeTradeNumber =
                            columnMap?.exchange_trade_number != null
                                ? cellAt(row, columnMap.exchange_trade_number)
                                : '';

                        results.push({
                            period: registrationDate || dateStr,
                            operationType: operation,
                            name,
                            regNum,
                            isin,
                            amount:
                                columnMap?.amount != null
                                    ? parseNumberCell(row[columnMap.amount])
                                    : amount,
                            quantity:
                                columnMap?.quantity != null
                                    ? parseNumberCell(row[columnMap.quantity])
                                    : quantity,
                            currency:
                                columnMap?.currency != null
                                    ? cellAt(row, columnMap.currency).toUpperCase()
                                    : currency,
                            registrationDate:
                                columnMap?.registrationDate != null
                                    ? cellAt(row, columnMap.registrationDate)
                                    : registrationDate,
                            fee,
                            repo_percent: repoPercent,
                            exchange_trade_number: exchangeTradeNumber,
                            debit_account: '',
                            credit_account: '',
                        });
                        seenTradeRow = true;
                    }
                }
            }
        }
    });

    return results;
}

function detectBrokerSection(data, sectionId = '1.2') {
    for (let i = 0; i < (data || []).length; i++) {
        const row = data[i];
        if (!Array.isArray(row)) continue;
        const rowText = row.map((v) => String(v)).join(' ');
        if (isBrokerSectionStart(rowText, sectionId)) return { found: true, startRow: i };
    }
    return { found: false, startRow: null };
}

function detectBrokerSection12(data) {
    return detectBrokerSection(data, '1.2');
}

function workbookToSheetData(workbook) {
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
}

function parseBroker(filePath, options = {}) {
    const workbook = xlsx.readFile(filePath, { cellDates: true });
    const data = workbookToSheetData(workbook);
    return parseBrokerSheet(data, filePath, options);
}

async function parseBrokerFromBuffer(buffer, options = {}) {
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    const data = workbookToSheetData(workbook);
    const sectionId = options.sectionId === '1.1' ? '1.1' : '1.2';
    let sectionStartRow = null;

    const detected = detectBrokerSection(data, sectionId);
    if (!detected.found && isBrokerLlmProbeEnabled() && !options.skipLlmProbe) {
        try {
            const { probeBrokerSectionStart } = require('./broker_section_probe');
            const probe = await probeBrokerSectionStart(data);
            if (probe.startRow != null) {
                sectionStartRow = probe.startRow;
            }
        } catch {
            /* regex-only fallback */
        }
    }

    return parseBrokerSheet(data, 'buffer', { sectionStartRow, sectionId });
}

function parseBrokerFromBufferSync(buffer, options = {}) {
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    const data = workbookToSheetData(workbook);
    const sectionId = options.sectionId === '1.1' ? '1.1' : '1.2';
    return parseBrokerSheet(data, 'buffer', { sectionId });
}

module.exports = {
    parseBroker,
    parseBrokerFromBuffer,
    parseBrokerFromBufferSync,
    parseBrokerSheet,
    isBrokerSection11Start,
    isBrokerSection12Start,
    isBrokerSectionStart,
    isBrokerSectionEnd,
    isBrokerSectionEndFor,
    brokerSectionTitleHead,
    isBrokerRowEmpty,
    isBrokerTableHeaderRow,
    isBrokerLaterSectionStart,
    isBrokerSectionGapEnd,
    detectBrokerSection,
    detectBrokerSection12,
    findBrokerHeaderMap,
    normalizeHeaderCell,
};
