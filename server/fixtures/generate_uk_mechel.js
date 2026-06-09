/**
 * Fixture по кейсу Мечел: БУ 1083.5 + Кол. 10; переоценка 61 на 91; сделка 97515.
 * node server/fixtures/generate_uk_mechel.js
 */
const path = require('path');
const xlsx = require('xlsx');

const OUT = path.join(__dirname, 'uk_card_mechel.xlsx');

const rows = [];
for (let i = 0; i < 7; i++) rows.push(Array(12).fill(''));

rows.push([
    '30.12.2024',
    'Сделка с ц/б HKP083939 от 30.12.2024 10:51:47\nПоступление ц/б',
    '',
    'Мечел, ап, 2-01-55005-E',
    '',
    'БУ',
    '58.01.4',
    '1083.50',
    '',
    '76.07.2',
    '',
    '',
]);
rows.push(['', '', '', '', '', 'Кол.', '', '10', '17305836', '', '', '']);

rows.push([
    '30.12.2024',
    'Сделка с ц/б HKP083939 от 30.12.2024 10:51:47\nПереоценка завершенных сделок (Тело ценной бумаги)',
    '',
    'Мечел, ап, 2-01-55005-E',
    '',
    'БУ',
    '58.01.4',
    '61.00',
    '',
    '91.01.10',
    '',
    '',
]);
rows.push(['', '', '', '', '', 'Кол.', '', '', '17305836', '', '', '']);

rows.push([
    '30.12.2024',
    'Сделка с ц/б HKP999999 от 30.12.2024 12:00:00\nПоступление ц/б',
    '',
    'Мечел, ап, 2-01-55005-E',
    '',
    'БУ',
    '58.01.4',
    '97515.00',
    '',
    '76.07.2',
    '',
    '',
]);
rows.push(['', '', '', '', '', 'Кол.', '', '5', '17306736', '', '', '']);

const ws = xlsx.utils.aoa_to_sheet(rows);
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, ws, 'TDSheet');
xlsx.writeFile(wb, OUT);
console.log('Wrote', OUT);
