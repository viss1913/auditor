const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { trickyPath } = require('./_paths');

function build76Rows() {
    return [
        ['Карточка счета 76'],
        ['Организация ООО Тест'],
        [''],
        ['Счет, Наименование счета'],
        ['Подразделение'],
        ['Контрагенты'],
        ['Договоры'],
        ['', 'Сальдо на начало периода', '', 'Обороты за период', '', 'Сальдо на конец периода'],
        ['', 'Дебет', 'Кредит', 'Дебет', 'Кредит', 'Дебет', 'Кредит'],
        ['76, Расчеты с разными дебиторами', 100, 0, 0, 0, 50, 0],
        ['76.01.1, Расчеты по страхованию', 60, 0, 0, 0, 30, 0],
        ['Подразделение 1', 22331, 0, 0, 0, 100, 0],
        ['Контрагент10 611', 0, 0, 1074346, 1074346, 0, 0],
        ['Договор 1', 0, 0, 104010, 104010, 0, 0],
        ['Договор 2', 0, 0, 500000, 500000, 0, 0],
        ['Договор 3', 0, 0, 470336, 470336, 0, 0],
        ['Подразделение 5', 141402, 0, 0, 0, 0, 0],
        ['Контрагент13 596', 0, 0, 0, 0, 0, 0],
        ['Договор 15', 141402, 0, 0, 0, 0, 0],
        ['Договор 16', 0, 0, 10, 10, 0, 0],
    ];
}

function genOs76CardClean() {
    const out = trickyPath('os_76', 'os76_card_clean.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ws = xlsx.utils.aoa_to_sheet(build76Rows());
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Исходная ОСВ');
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

module.exports = { genOs76CardClean, build76Rows };

if (require.main === module) {
    genOs76CardClean();
}
