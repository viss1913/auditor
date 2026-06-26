const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { FIXTURES_ROOT } = require('./_paths');
const FIXTURES_TRICKY = path.join(FIXTURES_ROOT, 'tricky');

function brokerSectionHeader(variant = 'standard') {
    if (variant === 'alt') {
        return '1.2 Сделки, ожидающие исполнения на отчётную дату';
    }
    return '1.2. Сделки, не исполнены на отчетную дату';
}

function writeBrokerWorkbook(filePath, { includeSection = true, variant = 'standard' } = {}) {
    const rows = [
        ['Отчёт брокера', '', '', ''],
        ['Раздел 1.1 Прочее', '', '', ''],
        ...(includeSection ? [[brokerSectionHeader(variant)]] : [['Раздел 1.1 Портфель']]),
        [
            '15.01.2024',
            '',
            'Покупка',
            'ПАО Test ISIN RU0009029540',
            100,
            50000,
            'RUB',
            '20.01.2024',
            '21.01.2024',
            50,
        ],
        [
            '16.01.2024',
            '',
            'Продажа',
            'Эмитент ISIN RU000A0JX0J2',
            10,
            9000,
            'RUB',
            '17.01.2024',
            '18.01.2024',
            5,
        ],
        ['1.3. Прочие операции', '', '', ''],
    ];
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    xlsx.writeFile(wb, filePath);
}

function generate() {
    const brokerDir = path.join(FIXTURES_TRICKY, 'broker');
    writeBrokerWorkbook(path.join(brokerDir, 'broker_1f018_clean.xlsx'), { includeSection: true });
    writeBrokerWorkbook(path.join(brokerDir, 'broker_1f018_alt_header.xlsx'), {
        includeSection: true,
        variant: 'alt',
    });
    console.log('broker fixtures:', brokerDir);
}

if (require.main === module) generate();

module.exports = { generate, writeBrokerWorkbook, brokerSectionHeader };
