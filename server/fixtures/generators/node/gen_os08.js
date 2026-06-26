const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { trickyPath } = require('./_paths');

function genOs08OsvClean() {
    const rows = [
        ['Оборотно-сальдовая ведомость по счёту 08', '', '', '', '', '', '', ''],
        ['ООО Тест', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        ['08', '', '', '', '', '', '', ''],
        ['Подразделение Центр', '', '', '', '', '', '', ''],
        ['Объект 80-000662 Сервер производственный', '', '', '', 19300, 500, 20000, 600],
        ['Объект 80-000663 Компьютер офисный', '', '', '', 8500, 200, 9000, 250],
        ['Подразделение Юг', '', '', '', '', '', '', ''],
        ['Объект 80-000664 Принтер лазерный', '', '', '', 3200, 100, 3300, 120],
    ];
    const out = trickyPath('os_08', 'os08_osv_clean.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'ОСВ 08');
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

function genOs76Vs08Trap() {
    const rows = [
        ['ОСВ по счёту 08', '', '', '', '', '', '', ''],
        ['08', '', '', '', '', '', '', ''],
        ['Подразделение 1', '', '', '', '', '', '', ''],
        ['Договор аренды №1', '', '', '', 1000, 0, 1000, 0],
        ['Объект 80-000700 Склад', '', '', '', 5000, 100, 5100, 150],
    ];
    const out = trickyPath('os_08', 'os76_vs_08_trap.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'ОСВ 08');
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

module.exports = { genOs08OsvClean, genOs76Vs08Trap };

if (require.main === module) {
    genOs08OsvClean();
    genOs76Vs08Trap();
}
