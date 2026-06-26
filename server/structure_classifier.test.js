const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { classifySheetStructure } = require('./structure_classifier');

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(relPath, sheetName = null) {
    const buf = fs.readFileSync(path.join(FIXTURES, relPath));
    const loaded = readSheetWithMeta(buf, sheetName, { useExcelProbe: true });
    const structure = classifySheetStructure(loaded.data, {
        hasOutline: loaded.hasOutline,
        rowOutlineLevels: loaded.rowOutlineLevels,
    });
    return { loaded, structure };
}

describe('structure_classifier', () => {
    it('card_76_07_6 → journal_1c с автопарсом', () => {
        const { structure } = loadFixture('tricky/journal/card_76_07_6.xlsx');
        assert.equal(structure.structure_id, 'journal_1c');
        assert.ok(structure.confidence >= 0.85);
        assert.equal(structure.autoParse, true);
        assert.equal(structure.ambiguous, false);
        assert.equal(structure.profileId, 'ks_card');
    });

    it('журнал с датами и Дт/Кт не ambiguous vs tree_os_08', () => {
        const data = [];
        data[1] = ['', 'Карточка счета 91'];
        data[7] = ['Период', 'Документ', '', 'Аналитика Дт', 'Аналитика Кт', 'Дебет', '', 'Кредит', '', 'Текущее сальдо'];
        data[8] = ['', '', '', '', '', 'Счет', '', 'Счет', '', ''];
        data[9] = ['Сальдо на начало', '', '', '', '', '', '', '', '', '', 'K', 302615527.25];
        for (let i = 0; i < 30; i++) {
            const day = String((i % 28) + 1).padStart(2, '0');
            data[10 + i] = [
                `${day}.12.2024`,
                `Операция ${i}`,
                '',
                'Контрагент',
                'Бумага',
                '91.01.3',
                1000 + i,
                '76.09',
                1000 + i,
                '',
                'K',
                100000 - i,
            ];
        }
        const structure = classifySheetStructure(data);
        assert.equal(structure.structure_id, 'journal_1c');
        assert.equal(structure.autoParse, true);
        assert.equal(structure.ambiguous, false);
    });

    it('os01_hierarchy_clean → hierarchy_os_01', () => {
        const { structure } = loadFixture('tricky/os_01/os01_hierarchy_clean.xlsx', 'Исходная выгрузка 01');
        assert.equal(structure.structure_id, 'hierarchy_os_01');
        assert.ok(structure.confidence >= 0.85);
        assert.equal(structure.profileId, 'catalog_scenario');
    });

    it('os76 fixture → tree_account_76 или journal (не os_01)', () => {
        const anton76 = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');
        if (!fs.existsSync(anton76)) return;
        const buf = fs.readFileSync(anton76);
        const loaded = readSheetWithMeta(buf, 'Исходная ОСВ', { useExcelProbe: true });
        const structure = classifySheetStructure(loaded.data, {
            hasOutline: loaded.hasOutline,
            rowOutlineLevels: loaded.rowOutlineLevels,
        });
        assert.notEqual(structure.structure_id, 'hierarchy_os_01');
        assert.ok(['tree_account_76', 'journal_1c', 'flat_osv'].includes(structure.structure_id));
    });

    it('empty_file → unknown', () => {
        const { structure } = loadFixture('tricky/edge/empty_file.xlsx');
        assert.equal(structure.structure_id, 'unknown');
        assert.equal(structure.autoParse, false);
    });

    it('uk_card_581 → uk_journal_58 без ambiguous, профиль uk_card', () => {
        const { structure } = loadFixture('uk_card_581.xlsx', 'TDSheet');
        assert.equal(structure.structure_id, 'uk_journal_58');
        assert.equal(structure.autoParse, true);
        assert.equal(structure.ambiguous, false);
        assert.equal(structure.profileId, 'uk_card');
    });

    it('журнал dtKt + БУ/Кол → uk_journal_58, не ambiguous vs journal_1c', () => {
        const rows = [];
        for (let i = 0; i < 7; i += 1) rows.push(Array(11).fill(''));
        rows.push([
            'Период',
            'Документ',
            '',
            'Аналитика Дт',
            'Аналитика Кт',
            'Показатель',
            'Дебет',
            '',
            'Кредит',
            '',
            'Текущее сальдо',
        ]);
        rows.push(['', '', '', '', '', '', 'Счет', '', 'Счет', '', '']);
        for (let i = 0; i < 50; i += 1) {
            const d = `${String((i % 28) + 1).padStart(2, '0')}.12.2024`;
            rows.push([d, 'Сделка', '', 'Бумага TEST', '', 'БУ', '58.01.4', 1000 + i, '', '76.07.2', '', '']);
            rows.push(['', '', '', '', '', 'Кол.', '', 10, '', '', '', '']);
        }
        const structure = classifySheetStructure(rows);
        assert.equal(structure.structure_id, 'uk_journal_58');
        assert.equal(structure.autoParse, true);
        assert.equal(structure.ambiguous, false);
        assert.equal(structure.profileId, 'uk_card');
    });
});
