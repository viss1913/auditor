const xlsx = require('xlsx');

function parseBrokerSheet(data, logLabel = '') {
    const results = [];
    let inSection = false;

    if (logLabel) {
        console.log(`--- Парсинг Брокера (v10) --- Файл: ${logLabel}`);
    }

    data.forEach((row, index) => {
        if (!Array.isArray(row)) return;
        const rowText = row.map(v => String(v)).join(' ').toLowerCase();

        // Поиск начала раздела 1.2
        if (!inSection && rowText.includes('1.2.') && rowText.includes('сделки') && rowText.includes('не исполнены')) {
            inSection = true;
            return;
        }

        // Поиск конца раздела
        if (inSection && (rowText.includes('1.3.') || rowText.includes('раздел 2'))) {
            const startText = row.slice(0, 10).join(' ').toLowerCase();
            if (startText.includes('1.3.') || startText.includes('раздел 2') || startText.includes('2.')) {
                inSection = false;
            }
        }

        if (inSection) {
            let dateStr = '';
            let dateIdx = -1;

            // Ищем дату в первых 5 колонках
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
                // Ищем тип операции
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
                    let longCells = [];
                    for (let i = opIdx + 1; i < row.length; i++) {
                        const val = String(row[i] || '').trim();
                        if (val.length > 3) {
                            longCells.push({ val: val.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim(), idx: i });
                        }
                    }

                    let securityInfo = '';
                    let infoIdx = -1;

                    // Стратегия 1: ищем ячейку с явным ISIN
                    for (const cell of longCells) {
                        if (/ISIN/i.test(cell.val) || /[A-Z]{2}[A-Z0-9]{10}/.test(cell.val) || /\d[\dА-Яа-яA-Za-z]{0,3}-\d{2}-\d{4,6}/.test(cell.val)) {
                            securityInfo = cell.val;
                            infoIdx = cell.idx;
                            break;
                        }
                    }

                    // Стратегия 2: если ISIN не найден, берём 2-ю длинную ячейку
                    if (!securityInfo && longCells.length >= 2) {
                        securityInfo = longCells[1].val;
                        infoIdx = longCells[1].idx;
                    }
                    if (!securityInfo && longCells.length === 1) {
                        securityInfo = longCells[0].val;
                        infoIdx = longCells[0].idx;
                    }

                    if (securityInfo) {
                        const isinMatch = securityInfo.match(/ISIN[:\s]+([A-Z]{2}[A-Z0-9]{10})/i) || securityInfo.match(/\b([A-Z]{2}[A-Z0-9]{10})\b/);
                        const isin = isinMatch ? isinMatch[1] : '';

                        // Паттерн 1: "1-01-12345-A" (с дефисами)
                        const regMatch = securityInfo.match(/(\d[\dА-Яа-яA-Za-z]{0,3}-\d{2}-\d{4,6}-[А-ЯA-Z\d-]+)/i);
                        // Паттерн 2: "10100963B" — цифры + буква (без дефисов)
                        const regMatchShort = !regMatch ? securityInfo.match(/\b(\d{7,9}[A-Z])\b/) : null;
                        const regNum = regMatch ? regMatch[1] : (regMatchShort ? regMatchShort[1] : '');
                        const regMatchUsed = regMatch || regMatchShort;

                        let name = securityInfo;
                        if (isinMatch) name = name.split(isinMatch[0])[0];
                        if (regMatchUsed) name = name.replace(regMatchUsed[0], '');
                        name = name.replace(/ISIN/gi, '').replace(/[№\u2116]\s*/g, '').trim();
                        name = name.replace(/[\s,;|]+$/, '').trim();

                        // Извлекаем числа для Кол-ва и Суммы
                        let foundNums = [];
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

                        // Ищем Валюту, Даты регистрации/оплаты и Комиссии
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
                                    // Пропускаем дату оплаты, которая идет следом
                                    for (let j = i + 1; j < row.length; j++) {
                                        if (row[j] instanceof Date || /^(\d{2}\.\d{2}\.\d{4})/.test(String(row[j]).trim())) {
                                            regDateIdx = j; // Индекс последней найденной даты (дата оплаты)
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
                                    // Ищем вторую дату
                                    for (let j = i + 1; j < row.length; j++) {
                                        if (row[j] instanceof Date || /^(\d{2}\.\d{2}\.\d{4})/.test(String(row[j]).trim())) {
                                            regDateIdx = j;
                                            break;
                                        }
                                    }
                                    if (regDateIdx === -1) regDateIdx = i;
                                    break;
                                }
                            }
                        }

                        // Ищем комиссии после дат (все числовые значения суммируем)
                        let fee = 0;
                        if (regDateIdx !== -1) {
                            let totalFee = 0;
                            let feeFound = false;

                            // Комиссии могут быть очень далеко (из-за пустых столбцов объединения)
                            // Идем прямо до конца строки, пока не встретим стоп-слова (Портфель/Субсчет)
                            for (let i = regDateIdx + 1; i < row.length; i++) {
                                const val = row[i];
                                if (val === undefined || val === null || val === '') continue;

                                const svalText = String(val).trim().toUpperCase();

                                // Стоп-слова: дошли до Портфеля (1F018...)
                                if (svalText.includes('1F018') || svalText.includes('ПОРТФЕЛЬ')) {
                                    break;
                                }

                                // Пропускаем названия валют комиссий и текст РЕПО
                                if (['RUB', 'USD', 'EUR', 'CNY'].includes(svalText) || svalText.includes('РЕПО') || svalText.includes('НОМЕР')) {
                                    continue;
                                }

                                if (typeof val === 'number') {
                                    if (val < 1000000) {
                                        totalFee += val;
                                        feeFound = true;
                                    } else {
                                        continue; // Это номер сделки (>1 млн), пропускаем
                                    }
                                } else {
                                    const strNum = String(val).replace(/\s/g, '').replace(',', '.');
                                    const n = parseFloat(strNum);
                                    if (!isNaN(n) && typeof val !== 'boolean') {
                                        if (n < 1000000) {
                                            totalFee += n;
                                            feeFound = true;
                                        } else {
                                            continue; // Номер сделки
                                        }
                                    }
                                }
                            }
                            if (feeFound) fee = totalFee;
                        }

                        console.log(`[PARSED] ${dateStr} | ${operation} | ${name} | regDate=${registrationDate} | curr=${currency} | fee=${fee}`);

                        results.push({
                            period: registrationDate || dateStr,
                            operationType: operation,
                            name,
                            regNum,
                            isin,
                            amount,
                            quantity,
                            currency,
                            registrationDate,
                            fee,
                            debit_account: '',
                            credit_account: ''
                        });
                    }
                }
            }
        }
    });

    return results;
}

function workbookToSheetData(workbook) {
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    return xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
}

function parseBroker(filePath) {
    const workbook = xlsx.readFile(filePath, { cellDates: true });
    const data = workbookToSheetData(workbook);
    return parseBrokerSheet(data, filePath);
}

function parseBrokerFromBuffer(buffer) {
    const workbook = xlsx.read(buffer, { type: 'buffer', cellDates: true });
    const data = workbookToSheetData(workbook);
    return parseBrokerSheet(data, 'buffer');
}

module.exports = {
    parseBroker,
    parseBrokerFromBuffer,
    parseBrokerSheet,
};
