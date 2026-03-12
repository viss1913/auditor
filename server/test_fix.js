const xlsx = require('xlsx');
const path = require('path');

function parseUK(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    const results = [];
    let lastEntryAwaitingQty = null;

    data.forEach((row, index) => {
        if (index < 7) return;
        const firstCol = String(row[0] || '').trim();
        const isDate = /^\d{2}\.\d{2}\.\d{4}/.test(firstCol);
        const pokazatel = String(row[5] || '').trim();

        if (isDate && (pokazatel === 'БУ' || pokazatel === '')) {
            const dbAcc = String(row[6] || '').trim();
            const crAcc = String(row[9] || '').trim();
            if (dbAcc.includes('58.01') && crAcc.startsWith('76')) {
                const newEntry = {
                    name: String(row[3] || '').split(',')[0],
                    amount: 0,
                    quantity: 0
                };
                results.push(newEntry);
                lastEntryAwaitingQty = newEntry;
            }
        } else if (lastEntryAwaitingQty && pokazatel === 'Кол.') {
            lastEntryAwaitingQty.quantity = parseFloat(String(row[7] || '0').replace(/\s/g, '').replace(',', '.'));
            lastEntryAwaitingQty.amount = parseFloat(String(row[14] || '0').replace(/\s/g, '').replace(',', '.'));
            lastEntryAwaitingQty = null;
        }
    });
    return results;
}

const testFile = 'c:/Users/User/Desktop/auditor_3/server/uploads/14ae68ff1cdd70b5015d5a17f2634b0e';
const res = parseUK(testFile);
console.log('Первые 3 сделки после фикса:');
console.log(res.slice(0, 3));

const total = res.reduce((acc, curr) => acc + curr.amount, 0);
console.log('Итоговая сумма по этому файлу:', total.toLocaleString('ru-RU'));
