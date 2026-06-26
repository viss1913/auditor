const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');

function extractAccountFromFilename(fileName) {
    const match = String(fileName || '').match(/\(([^)]+)\)/);
    if (match) return match[1].trim();
    const fallbackMatch = String(fileName || '').match(/\b(\d+)\b/);
    return fallbackMatch ? fallbackMatch[1].trim() : '';
}

function extractDepoAccountFromLines(lines) {
    for (const line of lines) {
        const m = String(line || '').match(/^Счет\/счет\s+ДЕПО:\s*([^\s]+)/i);
        if (m) return m[1].trim();
    }
    return '';
}

function parseDepoLines(lines, fileName = '', logLabel = '') {
    const results = [];
    const accountFromFilename = extractAccountFromFilename(fileName);
    const depoAccount = extractDepoAccountFromLines(lines);

    if (logLabel) {
        console.log(`[DEPO PARSE] fileName: "${fileName}", account extracted: "${accountFromFilename}"`);
        console.log(`--- Парсинг ДЕПО (PDF) --- ${logLabel}`);
    }

    let currentName = '';
    let currentRegNum = '';
    let currentIsin = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.includes('(Наименование эмитента, тип ценных бумаг)')) {
            currentName = lines[i - 1] || '';
            continue;
        }

        if (line.includes('(Номер гос. регистрации выпуска/ISIN-код/номер ПДУ/Номер закладной)')) {
            const val = (lines[i - 1] || '').trim();
            if (/^[A-Z0-9]{12}$/.test(val)) {
                currentIsin = val;
                currentRegNum = '';
            } else {
                currentRegNum = val;
                currentIsin = '';
            }
            continue;
        }

        if (line === 'Зачисление ЦБ' || line === 'Списание ЦБ') {
            const opType = line;
            const prevLine = lines[i - 1] || '';
            const dateMatch = prevLine.match(/^(\d{2}\.\d{2}\.\d{4})/);
            const dateStr = dateMatch ? dateMatch[1] : '';

            let quantity = 0;
            for (let j = i + 1; j < Math.min(i + 15, lines.length); j++) {
                const nextLine = lines[j];
                const qtyMatch = nextLine.match(/^([\d\s]+)[Оо]тчет\s*[N№No]/);
                if (qtyMatch) {
                    quantity = parseFloat(qtyMatch[1].replace(/\s/g, ''));
                    break;
                }
            }

            if (dateStr && (currentName || currentRegNum || currentIsin)) {
                results.push({
                    period: dateStr,
                    operationType: opType,
                    name: currentName,
                    regNum: currentRegNum,
                    isin: currentIsin,
                    amount: 0,
                    quantity,
                    currency: 'RUB',
                    registrationDate: dateStr,
                    fee: 0,
                    debit_account: accountFromFilename,
                    credit_account: '',
                    depo_account: depoAccount,
                });
            }
        }
    }

    if (logLabel) console.log(`[DEPO] Распознано записей: ${results.length}`);
    return results;
}

async function parseDepoFromBuffer(buffer, fileName = '') {
    const pdfData = await pdfParse(buffer);
    const lines = pdfData.text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    return parseDepoLines(lines, fileName, `buffer:${fileName}`);
}

async function parseDepo(filePath, fileName = '') {
    if (!fs.existsSync(filePath)) return [];
    const dataBuffer = fs.readFileSync(filePath);
    return parseDepoFromBuffer(dataBuffer, fileName || path.basename(filePath));
}

module.exports = {
    parseDepo,
    parseDepoFromBuffer,
    parseDepoLines,
    extractAccountFromFilename,
    extractDepoAccountFromLines,
};
