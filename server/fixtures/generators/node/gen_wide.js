const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { trickyPath } = require('./_paths');

function genWideMetricsYears() {
    const header = [
        'Группа',
        'ОС',
        '2022 - начало',
        '2022 - амортизация',
        '2022 - конец',
        '2023 - начало',
        '2023 - амортизация',
        '2023 - конец',
        '2024 - начало',
        '2024 - амортизация',
        '2024 - конец',
    ];
    const rows = [
        ['Ведомость ОС wide metrics', '', '', '', '', '', '', '', '', '', ''],
        ['ООО Тест', '', '', '', '', '', '', '', '', '', ''],
        header,
        ['Здания', '', '', '', '', '', '', '', '', '', ''],
        ['ОП Центральный', '', '', '', '', '', '', '', '', '', ''],
        [
            '80-000001 Ангар металлический инв. №11111 от 01.01.2020',
            '',
            100,
            20,
            80,
            110,
            25,
            85,
            120,
            30,
            90,
        ],
        [
            '80-000002 Склад производственный инв. №22222 от 02.02.2021',
            '',
            200,
            40,
            160,
            210,
            45,
            165,
            220,
            50,
            170,
        ],
    ];
    const out = trickyPath('wide', 'wide_metrics_years.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Исходная выгрузка 01');
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

module.exports = { genWideMetricsYears };

if (require.main === module) {
    genWideMetricsYears();
}
