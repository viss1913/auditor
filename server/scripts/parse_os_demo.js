/**
 * Демо: парсинг «Пример для ТЗ ФАС- ОС.xlsx» по JSON-правилам.
 * Запуск из папки server: node scripts/parse_os_demo.js
 */
const path = require('path');
const { smartParseOS, loadRuleFromFile, writeFlatExcel } = require('../smart_parse_os');

const root = path.join(__dirname, '..', '..');
const sampleXlsx = path.join(root, 'Пример для ТЗ ФАС- ОС.xlsx');
const outDir = path.join(root, 'output');

const rules = [
    { rule: path.join(__dirname, '..', 'rules', 'fas_os_01.json'), out: 'fas_os_01_flat.xlsx' },
    { rule: path.join(__dirname, '..', 'rules', 'fas_os_08.json'), out: 'fas_os_08_flat.xlsx' },
];

const fs = require('fs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

for (const { rule: rulePath, out } of rules) {
    const ruleJSON = loadRuleFromFile(rulePath);
    const { rows, headers, sheetName, variant } = smartParseOS(sampleXlsx, ruleJSON);
    const outPath = path.join(outDir, out);
    writeFlatExcel(rows, headers, outPath);
    console.log(`→ ${out} (${rows.length} строк, лист «${sheetName}», ${variant})`);
    if (rows[0]) {
        console.log('  пример:', JSON.stringify(rows[0], null, 0).slice(0, 200), '…');
    }
}

console.log('\nГотово. Файлы в папке output/');
