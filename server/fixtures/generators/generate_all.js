#!/usr/bin/env node
/**
 * Генерация всех tricky-фикстур.
 * node server/fixtures/generators/generate_all.js
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const pythonScript = path.join(__dirname, 'python', 'gen_tricky_os01.py');

console.log('=== Node generators ===');
const os01 = require('./node/gen_os01.js');
os01.genOs01HierarchyClean();
os01.genOs01FlatOnly();
os01.genOs01ShallowTree();
os01.genCompositeMultiDate();
os01.genWrongShiftedCols();
os01.genEmptyFile();
os01.genMultiEmptyActive();
os01.genMultiMixedBook();

const os08 = require('./node/gen_os08.js');
os08.genOs08OsvClean();
os08.genOs76Vs08Trap();

require('./node/gen_os76.js').genOs76CardClean();

const uk = require('./node/gen_uk.js');
uk.genUkQtyColI();
uk.genBrokerNoSection();

require('./node/gen_wide.js').genWideMetricsYears();
require('./node/gen_from_target.js').genFromTargetPair();
require('./node/gen_broker.js').generate();

console.log('=== Python generators (openpyxl) ===');
try {
    execSync(`python "${pythonScript}"`, { stdio: 'inherit' });
} catch {
    try {
        execSync(`py "${pythonScript}"`, { stdio: 'inherit' });
    } catch (e) {
        console.warn('Python/openpyxl skipped:', e.message);
    }
}

console.log('=== Reference copies ===');
const fixturesRoot = path.join(__dirname, '..');
const refDir = path.join(fixturesRoot, 'tricky', 'reference');
fs.mkdirSync(refDir, { recursive: true });

const copies = [
    {
        src: path.join(fixturesRoot, '..', '..', 'Пример для ТЗ ФАС- ОС.xlsx'),
        dst: path.join(refDir, 'fas_os_sample.xlsx'),
    },
    {
        src: path.join(fixturesRoot, 'Пример по сч 76.xlsx'),
        dst: path.join(refDir, 'os76_multisheet.xlsx'),
    },
];

for (const { src, dst } of copies) {
    if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst);
        console.log('Copied', path.basename(dst));
    } else {
        console.warn('Skip copy (missing):', src);
    }
}

console.log('Done.');
