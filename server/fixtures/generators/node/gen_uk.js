const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { trickyPath } = require('./_paths');

/** Кол-во в col I (index 8), сальдо в col H (index 7) */
function genUkQtyColI() {
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(Array(12).fill(''));
    rows.push([
        '30.12.2024',
        'Сделка с ц/б TEST001 от 30.12.2024',
        '',
        'Бумага Тестовая серия А',
        '',
        'БУ',
        '58.01.4',
        '1083.50',
        '10',
        '76.07.2',
        '',
        '',
    ]);
    rows.push(['', '', '', '', '', 'Кол.', '', '', '17305836', '', '', '']);
    rows.push([
        '30.12.2024',
        'Сделка с ц/б TEST002 от 30.12.2024',
        '',
        'Бумага Тестовая серия Б',
        '',
        'БУ',
        '58.01.4',
        '5000.00',
        '25',
        '76.07.2',
        '',
        '',
    ]);
    rows.push(['', '', '', '', '', 'Кол.', '', '', '25000000', '', '', '']);

    const out = trickyPath('uk', 'uk_qty_col_i.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'TDSheet');
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

function genBrokerNoSection() {
    const rows = [
        ['Отчёт брокера без раздела 1.2'],
        ['Дата', 'Тип', 'Бумага', 'Кол-во', 'Сумма'],
        ['01.01.2024', 'Покупка', 'TEST', '10', '1000'],
    ];
    const out = trickyPath('edge', 'broker_no_section.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

module.exports = { genUkQtyColI, genBrokerNoSection };

if (require.main === module) {
    genUkQtyColI();
    genBrokerNoSection();
}
