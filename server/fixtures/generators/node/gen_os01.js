const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { trickyPath } = require('./_paths');
const { buildOS01HierarchyRows, shallowTreeRows } = require('./os01_base');

function writeSheet(outPath, sheetName, rows) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, sheetName);
    xlsx.writeFile(wb, outPath);
    console.log('Wrote', outPath);
}

function genOs01HierarchyClean() {
    writeSheet(
        trickyPath('os_01', 'os01_hierarchy_clean.xlsx'),
        'Исходная выгрузка 01',
        buildOS01HierarchyRows()
    );
}

function genOs01FlatOnly() {
    writeSheet(
        trickyPath('os_01', 'os01_flat_only.xlsx'),
        'Исходная выгрузка 01',
        buildOS01HierarchyRows()
    );
}

function genOs01ShallowTree() {
    writeSheet(trickyPath('edge', 'os01_shallow_tree.xlsx'), 'Исходная выгрузка 01', shallowTreeRows());
}

function genCompositeMultiDate() {
    const rows = buildOS01HierarchyRows([
        [
            'Блок офисный, 000002272, 01.10.2018, 15.06.2021 доп. текст',
            300,
            50,
            10,
            5,
            305,
            55,
        ],
    ]);
    writeSheet(trickyPath('os_01', 'composite_multi_date.xlsx'), 'Исходная выгрузка 01', rows);
}

function genWrongShiftedCols() {
    const rows = buildOS01HierarchyRows();
    const shifted = rows.map((r) => ['', ...r]);
    writeSheet(trickyPath('edge', 'wrong_shifted_cols.xlsx'), 'Исходная выгрузка 01', shifted);
}

function genEmptyFile() {
    writeSheet(trickyPath('edge', 'empty_file.xlsx'), 'Лист1', [[''], ['']]);
}

function genMultiEmptyActive() {
    const out = trickyPath('multi', 'multi_empty_active.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([[''], ['']]), 'Лист1');
    xlsx.utils.book_append_sheet(
        wb,
        xlsx.utils.aoa_to_sheet(buildOS01HierarchyRows()),
        'Исходная выгрузка 01'
    );
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

function genMultiMixedBook() {
    const out = trickyPath('multi', 'multi_mixed_book.xlsx');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(
        wb,
        xlsx.utils.aoa_to_sheet(buildOS01HierarchyRows()),
        'Исходная выгрузка 01'
    );
    const ukRows = [];
    for (let i = 0; i < 7; i++) ukRows.push(Array(12).fill(''));
    ukRows.push([
        '30.12.2024',
        'Сделка тест',
        '',
        'Бумага TEST',
        '',
        'БУ',
        '58.01.4',
        '1000.00',
        '',
        '76.07.2',
        '',
        '',
    ]);
    ukRows.push(['', '', '', '', '', 'Кол.', '', '10', '100000', '', '', '']);
    xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(ukRows), 'TDSheet');
    xlsx.utils.book_append_sheet(
        wb,
        xlsx.utils.aoa_to_sheet([
            ['Инструкция по заполнению'],
            ['Этот лист не содержит данных для парсинга'],
        ]),
        'Инструкция'
    );
    xlsx.writeFile(wb, out);
    console.log('Wrote', out);
}

module.exports = {
    genOs01HierarchyClean,
    genOs01FlatOnly,
    genOs01ShallowTree,
    genCompositeMultiDate,
    genWrongShiftedCols,
    genEmptyFile,
    genMultiEmptyActive,
    genMultiMixedBook,
};

if (require.main === module) {
    genOs01HierarchyClean();
    genOs01FlatOnly();
    genOs01ShallowTree();
    genCompositeMultiDate();
    genWrongShiftedCols();
    genEmptyFile();
    genMultiEmptyActive();
    genMultiMixedBook();
}
