/**
 * Генератор fixture «карт 58.1_HP.xlsx» (~500 пар БУ/Кол.)
 * node server/fixtures/generate_uk_card_581.js
 */
const path = require('path');
const xlsx = require('xlsx');

const OUT = path.join(__dirname, 'uk_card_581.xlsx');
const PAIRS = 250;

const rows = [];
for (let i = 0; i < 7; i++) rows.push(['', '', '', '', '', '', '', '', '', '']);

for (let i = 0; i < PAIRS; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String((i % 12) + 1).padStart(2, '0');
    rows.push([
        `${day}.${month}.2024`,
        '',
        '',
        `Облигация TEST-${1000 + i}, REG${10000000 + i}`,
        '',
        'БУ',
        '58.01',
        1000 + i * 10,
        '',
        '76.01',
    ]);
    rows.push(['', '', '', '', '', 'Кол.', '', '', 10 + (i % 5), '']);
}

const ws = xlsx.utils.aoa_to_sheet(rows);
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, ws, 'TDSheet');
xlsx.writeFile(wb, OUT);
console.log('Wrote', OUT, 'rows', rows.length);
