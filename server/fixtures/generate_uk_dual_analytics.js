/**
 * Карточка 58.01 с отдельными колонками «Аналитика Дт» и «Аналитика Кт» (как в выгрузке НР).
 * node server/fixtures/generate_uk_dual_analytics.js
 */
const path = require('path');
const xlsx = require('xlsx');

const OUT = path.join(__dirname, 'uk_card_dual_analytics.xlsx');

const rows = [];
for (let i = 0; i < 5; i++) rows.push(Array(13).fill(''));

rows.push([
    'Период',
    'Документ',
    'Аналитика Дт',
    'Аналитика Кт',
    '',
    'Показатель',
    'Дебет',
    '',
    'Кредит',
    '',
    'Текущее сальдо',
    '',
    '',
]);
rows.push([
    '',
    '',
    '',
    '',
    '',
    '',
    'Счет',
    'Сумма',
    'Счет',
    'Сумма',
    'Сумма',
    'Кол.',
    '',
]);

rows.push([
    '30.12.2024',
    'Сделка с ц/б HKP083939 от 30.12.2024 10:51:47 Поступление ц/б',
    'Мечел, ап, 2-01-55005-E',
    'ООО СБ-Брокер',
    '',
    'БУ',
    '58.01.4',
    '1083.50',
    '76.07.2',
    '',
    'Д',
    '7730755089.16',
    '',
]);
rows.push(['', '', '', '', '', 'Кол.', '', '10', '', '', 'Д', '17305836', '']);

const ws = xlsx.utils.aoa_to_sheet(rows);
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, ws, 'TDSheet');
xlsx.writeFile(wb, OUT);
console.log('Wrote', OUT);
