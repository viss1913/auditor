const xlsx = require('xlsx');

/**
 * Стандартный парсинг карточки счёта УК: проводки Дт 58.01 / Кт 76.
 * @param {string} filePath
 * @returns {Array<{period, operationType, name, regNum, isin, amount, quantity, currency, registrationDate, fee, debit_account, credit_account}>}
 */
function parseUK(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    const results = [];
    let lastEntryAwaitingQty = null;

    console.log('--- Начинаю парсинг УК (v5) ---');

    data.forEach((row, index) => {
        if (index < 7) return;

        const firstCol = String(row[0] || '').trim();
        const isDate = /^\d{2}\.\d{2}\.\d{4}/.test(firstCol);
        const pokazatel = String(row[5] || '').trim();

        if (isDate && (pokazatel === 'БУ' || pokazatel === '')) {
            const dbAcc = String(row[6] || '').trim();
            const crAcc = String(row[9] || '').trim();

            if (dbAcc.includes('58.01') && crAcc.startsWith('76')) {
                const analytics = String(row[3] || '').trim();
                const parts = analytics.split(',').map(s => s.trim());
                let name = parts.slice(0, Math.max(1, parts.length - 1)).join(', ') || analytics;
                let regNum = parts.length > 1 ? parts[parts.length - 1] : '';

                let amountRaw = String(row[7] || '0').replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
                let amount = parseFloat(amountRaw);
                if (isNaN(amount)) amount = 0;

                const newEntry = {
                    period: null,
                    operationType: 'Покупка',
                    name,
                    regNum,
                    isin: '',
                    amount,
                    quantity: 0,
                    currency: 'RUB',
                    registrationDate: firstCol,
                    fee: 0,
                    debit_account: dbAcc,
                    credit_account: crAcc
                };
                results.push(newEntry);
                lastEntryAwaitingQty = newEntry;
            } else {
                lastEntryAwaitingQty = null;
            }
        } else if (lastEntryAwaitingQty && pokazatel === 'Кол.') {
            let qty = 0;
            const strVal = String(row[7] || '0').replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
            const parsed = parseFloat(strVal);
            if (!isNaN(parsed)) qty = parsed;

            lastEntryAwaitingQty.quantity = qty;
            lastEntryAwaitingQty = null;
        }
    });

    return results;
}

module.exports = { parseUK };
