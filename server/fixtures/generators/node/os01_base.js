/** Shared OS 01 hierarchy row builder for tricky fixtures */

function blank(cols = 8) {
    return Array(cols).fill('');
}

function os01HeaderBlock() {
    return [
        ['Ведомость амортизации основных средств', '', '', '', '', '', '', ''],
        ['ООО Тест Fixture', '', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', ''],
        ['', 'На начало периода', '', 'За период', '', 'На конец периода', '', ''],
        ['', 'стоимость', 'амортизация', 'стоимость', 'амортизация', 'стоимость', 'амортизация', ''],
    ];
}

function os01TreeBlock(options = {}) {
    const assets = options.assets || [
        {
            group: 'Здания',
            unit: 'РТК Волгоград',
            branch: 'ОП АБГ-Волгоград',
            name: '80-000001 Склад производственный инв. №12345 от 01.01.2020',
            metrics: [1000, 200, 50, 30, 1020, 230],
        },
        {
            group: 'Машины',
            unit: 'РТК Москва',
            branch: 'ОП Центральный',
            name: '80-000002 Станок токарный инв. №67890 от 15.06.2019',
            metrics: [5000, 1200, 100, 80, 5020, 1280],
        },
        {
            group: 'Машины',
            unit: 'РТК Москва',
            branch: 'ОП Центральный',
            name: '80-000003 Пресс гидравлический инв. №11111 от 20.03.2021',
            metrics: [8000, 1500, 200, 150, 8100, 1650],
        },
    ];

    const rows = [];
    let lastGroup = '';
    let lastUnit = '';
    let lastBranch = '';

    for (const a of assets) {
        if (a.group !== lastGroup) {
            rows.push([a.group, ...blank(7)]);
            lastGroup = a.group;
            lastUnit = '';
            lastBranch = '';
        }
        if (a.unit !== lastUnit) {
            rows.push([a.unit, ...blank(7)]);
            lastUnit = a.unit;
            lastBranch = '';
        }
        if (a.branch !== lastBranch) {
            rows.push([a.branch, ...blank(7)]);
            lastBranch = a.branch;
        }
        rows.push([a.name, ...(a.metrics || blank(6).slice(0, 6))]);
    }
    return rows;
}

function buildOS01HierarchyRows(extraRows = []) {
    return [...os01HeaderBlock(), ...os01TreeBlock(), ...extraRows];
}

function shallowTreeRows() {
    return [
        ...os01HeaderBlock(),
        ['Здания', ...blank(7)],
        ['80-000010 Кiosk торговый инв. №99999 от 01.01.2022', 100, 10, 5, 2, 103, 12],
        ['80-000011 Ангар металлический инв. №88888 от 02.02.2022', 200, 20, 8, 4, 204, 24],
    ];
}

module.exports = {
    blank,
    os01HeaderBlock,
    os01TreeBlock,
    buildOS01HierarchyRows,
    shallowTreeRows,
};
