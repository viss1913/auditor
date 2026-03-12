const fs = require('fs');
const pdfParse = require('pdf-parse');

async function parseDepo(filePath, fileName = '') {
    if (!fs.existsSync(filePath)) return [];

    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);

    const lines = pdfData.text.split('\n').map(l => l.trim()).filter(l => l !== '');
    const results = [];

    let accountFromFilename = '';
    const match = fileName.match(/\(([^)]+)\)/);
    if (match) {
        accountFromFilename = match[1].trim();
    } else {
        const fallbackMatch = fileName.match(/\b(\d+)\b/);
        if (fallbackMatch) accountFromFilename = fallbackMatch[1].trim();
    }
    console.log(`[DEPO PARSE] fileName: "${fileName}", account extracted: "${accountFromFilename}"`);

    let currentName = '';
    let currentRegNum = '';
    let currentIsin = '';

    console.log(`--- Парсинг ДЕПО (PDF) --- Файл: ${filePath}`);

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
                    quantity: quantity,
                    currency: 'RUB',
                    registrationDate: dateStr,
                    fee: 0,
                    debit_account: accountFromFilename,
                    credit_account: ''
                });
            }
        }
    }
    return results;
}

parseDepo('../Выписка о движении ценных бумаг по счету депо (30).pdf', 'Выписка о движении ценных бумаг по счету депо (30).pdf')
    .then(r => console.log('Parsed items:', r.length, 'Sample:', r[0]))
    .catch(console.error);

const files = fs.readdirSync('../uploads').slice(0, 1);
if (files.length > 0) {
    parseDepo('../uploads/' + files[0], 'test (55).pdf').then(r => console.log('Uploads sample:', r[0]));
}
