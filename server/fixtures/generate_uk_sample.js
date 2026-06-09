/** Генерирует server/fixtures/uk_sample.xlsx для тестов и ручной проверки */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const rows = [];
for (let i = 0; i < 7; i++) rows.push(Array(10).fill(''));
rows.push(['01.06.2025', '', '', 'Тестовая бумага, 12345678', '', 'БУ', '58.01', '1000.50', '', '76.01']);
rows.push(['', '', '', '', '', 'Кол.', '', '25', '', '']);

const out = path.join(__dirname, 'uk_sample.xlsx');
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), 'Sheet1');
xlsx.writeFile(wb, out);
console.log('Created', out);
