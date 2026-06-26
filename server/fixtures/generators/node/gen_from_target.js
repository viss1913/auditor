const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { trickyPath } = require('./_paths');
const { buildOS01HierarchyRows } = require('./os01_base');

function genFromTargetPair() {
    const sourceRows = buildOS01HierarchyRows();
    const targetRows = [
        ['Группа', 'Узел', 'Подразделение', 'ОС', '2024 - начало', '2024 - амортизация', '2024 - конец'],
        [
            'Здания',
            'РТК Волгоград',
            'ОП АБГ-Волгоград',
            '80-000001 Склад производственный инв. №12345 от 01.01.2020',
            1000,
            200,
            1020,
        ],
        [
            'Машины',
            'РТК Москва',
            'ОП Центральный',
            '80-000002 Станок токарный инв. №67890 от 15.06.2019',
            5000,
            1200,
            5020,
        ],
    ];

    const dir = trickyPath('os_01');
    fs.mkdirSync(dir, { recursive: true });

    const sourceOut = path.join(dir, 'from_target_source.xlsx');
    const targetOut = path.join(dir, 'from_target_etalon.xlsx');

    const wbSource = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wbSource, xlsx.utils.aoa_to_sheet(sourceRows), 'Исходная выгрузка 01');
    xlsx.writeFile(wbSource, sourceOut);

    const wbTarget = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wbTarget, xlsx.utils.aoa_to_sheet(targetRows), 'эталон');
    xlsx.writeFile(wbTarget, targetOut);

    console.log('Wrote', sourceOut);
    console.log('Wrote', targetOut);
}

module.exports = { genFromTargetPair };

if (require.main === module) {
    genFromTargetPair();
}
