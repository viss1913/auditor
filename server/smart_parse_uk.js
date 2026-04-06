const xlsx = require('xlsx');

/**
 * Умный парсинг Excel файла УК по правилам, заданным в JSON
 * @param {string} filePath - Путь к файлу
 * @param {Object} ruleJSON - Объект правила (сгенерированный ИИ)
 * @returns {Array} - Массив объектов для сохранения в БД
 */
function smartParseUK(filePath, ruleJSON) {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    const results = [];
    const conditions = ruleJSON.conditions || {};

    console.log('--- Изолированный Умный Парсинг ---');
    console.log('Применяемые правила (JSON):', ruleJSON);

    let lastEntryAwaitingQty = null;

    // Вспомогательная функция для парсинга даты "ДД.ММ.ГГГГ" в Date объект
    const parseDate = (str) => {
        const parts = str.split('.');
        if (parts.length !== 3) return null;
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    };

    const dateStart = conditions.date_start ? new Date(conditions.date_start) : null;
    const dateEnd = conditions.date_end ? new Date(conditions.date_end) : null;

    data.forEach((row, index) => {
        if (index < 7) return;

        const firstCol = String(row[0] || '').trim();
        const isDatePattern = /^\d{2}\.\d{2}\.\d{4}/.test(firstCol);
        const pokazatel = String(row[5] || '').trim();

        // Если это строка с количеством — обрабатываем её, даже если даты нет (она относится к предыдущей строке Бух.Учета)
        if (lastEntryAwaitingQty && pokazatel === 'Кол.') {
            let qty = 0;
            const strVal = String(row[7] || '0').replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
            const parsed = parseFloat(strVal);
            if (!isNaN(parsed)) qty = parsed;

            lastEntryAwaitingQty.quantity = qty;
            lastEntryAwaitingQty = null;
            return; // Переходим к следующей строке
        }

        // Дальше работаем только со строками, где есть дата (основные операции)
        if (!isDatePattern) return;

        const rowDate = parseDate(firstCol);
        const dbAcc = String(row[6] || '').trim();
        const crAcc = String(row[9] || '').trim();

        let isMatch = true;

        // Фильтр по дебету
        if (conditions.debit_account) {
            if (!dbAcc.startsWith(conditions.debit_account)) isMatch = false;
        }
        // Фильтр по кредиту
        if (conditions.credit_account) {
            if (!crAcc.startsWith(conditions.credit_account)) isMatch = false;
        }
        // Фильтр по датам
        if (dateStart && rowDate < dateStart) isMatch = false;
        if (dateEnd && rowDate > dateEnd) isMatch = false;

        if ((pokazatel === 'БУ' || pokazatel === '') && isMatch) {
            const analytics = String(row[3] || '').trim();
            const parts = analytics.split(',').map(s => s.trim());
            let name = parts.slice(0, Math.max(1, parts.length - 1)).join(', ') || analytics;
            let regNum = parts.length > 1 ? parts[parts.length - 1] : '';

            let amountRaw = String(row[7] || '0').replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
            let amount = parseFloat(amountRaw);
            if (isNaN(amount)) amount = 0;

            const newEntry = {
                period: firstCol,
                operationType: ruleJSON.operation_type || 'Умная Операция',
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
        }
    });

    console.log(`Найдено записей по правилу: ${results.length}`);
    return results;
}

module.exports = {
    smartParseUK
};
