const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { classifySheetStructure } = require('./structure_classifier');
const { parseUkOsv58Sheet, detectUkOsv58Score } = require('./uk_osv_martin');

const FIXTURE_OSV = path.join(__dirname, 'fixtures', 'tricky', 'uk', 'uk_osv_58_01_4.xlsx');

function loadWealthOsv() {
    const fp = process.env.UK_OSV_58_FIXTURE || FIXTURE_OSV;
    if (!fs.existsSync(fp)) return null;
    const buf = fs.readFileSync(fp);
    const loaded = readSheetWithMeta(buf, 'TDSheet', { useExcelProbe: true });
    return { loaded, data: loaded.data };
}

function findHeader(parsed, pattern) {
    return parsed.headers.find((h) => pattern.test(h));
}

describe('uk_osv_martin', () => {
    it('синтетика: БУ и Кол. в одной строке, валюта с RUB-узла', () => {
        const data = [
            ['ОПИФРФИ', '', '', '', '', '', ''],
            ['Оборотно-сальдовая ведомость по счету 58.01.4 за 2024', '', '', '', '', '', ''],
            ['', '', '', '', '', '', ''],
            ['Счет', '', 'Показатели', 'Сальдо на начало', 'Сальдо на начало', 'Обороты', 'Обороты'],
            ['', '', '', 'Дебет', 'Кредит', 'Дебет', 'Кредит'],
            ['58.01.4', '', 'БУ', 100, '', 200, 150],
            ['58.01.4', '', 'Кол.', 10, '', 5, 3],
            ['Газпром, ао', '', 'БУ', '', '', 50, 40],
            ['Газпром, ао', '', 'Кол.', '', '', 2, 1],
            ['RUB', '', 'БУ', '', '', 50, 40],
        ];
        assert.ok(detectUkOsv58Score(data) >= 0.9);
        const parsed = parseUkOsv58Sheet(data);
        assert.ok(parsed);
        assert.equal(parsed.scenarioId, 'uk_osv_58');
        assert.equal(parsed.rows.length, 2);
        assert.ok(!parsed.headers.includes('Показатель'));
        assert.ok(parsed.headers.some((h) => /\/\s*БУ$/.test(h)));
        assert.ok(parsed.headers.some((h) => /\/\s*Кол\.$/.test(h)));

        const account = parsed.rows[0];
        const gazprom = parsed.rows[1];
        const openBu = findHeader(parsed, /начало.*Дебет.*БУ/i);
        const openKol = findHeader(parsed, /начало.*Дебет.*Кол/i);
        assert.equal(account[openBu], 100);
        assert.equal(account[openKol], 10);
        assert.equal(gazprom.Наименование, 'Газпром, ао');
        assert.equal(gazprom.Валюта, 'RUB');
        assert.equal(gazprom[findHeader(parsed, /Обороты.*Дебет.*БУ/i)], 50);
        assert.equal(gazprom[findHeader(parsed, /Обороты.*Дебет.*Кол/i)], 2);
    });

    it('синтетика: лишняя merged-колонка «Дебет» на конец периода', () => {
        const data = [
            ['ОПИФРФИ', '', '', '', '', '', '', '', ''],
            ['Оборотно-сальдовая ведомость по счету 58.01.7 за 2024', '', '', '', '', '', '', '', ''],
            ['', '', '', '', '', '', '', '', ''],
            ['Счет', '', 'Показатели', 'Сальдо на начало', 'Сальдо на начало', 'Обороты', 'Обороты', 'Сальдо на конец', 'Сальдо на конец', 'Сальдо на конец'],
            ['', '', '', 'Дебет', 'Кредит', 'Дебет', 'Кредит', 'Дебет', 'Дебет', 'Кредит'],
            ['58.01.7', '', 'БУ', 100, '', 200, 150, 500, 500, ''],
            ['58.01.7', '', 'Кол.', 10, '', 20, 15, 50, 50, ''],
        ];
        const parsed = parseUkOsv58Sheet(data);
        assert.ok(parsed);
        assert.equal(parsed.rows.length, 1);
        const closeBu = findHeader(parsed, /конец.*Дебет.*БУ/i);
        const closeKol = findHeader(parsed, /конец.*Дебет.*Кол/i);
        assert.ok(closeBu);
        assert.equal(parsed.rows[0][closeBu], 500);
        assert.equal(parsed.rows[0][closeKol], 50);
    });

    it('ОСВ 58.01.7: депозитарки wide + USD в колонке Валюта', () => {
        const fp =
            process.env.UK_OSV_587_FIXTURE ||
            path.join(__dirname, '..', '..', 'Auditor', 'data', 'Wealth managment', 'ОСВ 58.01.7.xlsx');
        if (!fs.existsSync(fp)) return;

        const loaded = readSheetWithMeta(fs.readFileSync(fp), 'TDSheet', { useExcelProbe: true });
        const parsed = parseUkOsv58Sheet(loaded.data);
        assert.ok(parsed?.rows?.length >= 4, `rows=${parsed?.rows?.length}`);

        const closeBuHeaders = parsed.headers.filter((h) => /конец.*Дебет.*БУ/i.test(h));
        assert.equal(closeBuHeaders.length, 1);

        const usdRows = parsed.rows.filter((r) => r.Валюта === 'USD');
        assert.ok(usdRows.length >= 3, `usd rows=${usdRows.length}`);
        assert.ok(parsed.rows.some((r) => /Cian/i.test(r.Наименование) && r.Валюта === 'USD'));
        const closeBu = closeBuHeaders[0];
        assert.ok(
            parsed.rows.some((r) => /Ozon/i.test(r.Наименование) && r[closeBu] === 118624500)
        );
    });

    it('fixture uk_osv_58_01_4 → uk_osv_58 без ambiguous', () => {
        const pack = loadWealthOsv();
        assert.ok(pack, 'fixture uk_osv_58_01_4.xlsx missing');

        const structure = classifySheetStructure(pack.data, {
            hasOutline: pack.loaded.hasOutline,
            rowOutlineLevels: pack.loaded.rowOutlineLevels,
        });
        assert.equal(structure.structure_id, 'uk_osv_58');
        assert.equal(structure.autoParse, true);
        assert.equal(structure.ambiguous, false);
        assert.equal(structure.profileId, 'uk_osv_58');

        const parsed = parseUkOsv58Sheet(pack.data);
        assert.ok(parsed?.rows?.length > 30, `rows=${parsed?.rows?.length}`);
        assert.ok(parsed.headers.some((h) => /\/\s*БУ$/.test(h)));
        assert.ok(parsed.rows.some((r) => /втб/i.test(r.Наименование) && r.Валюта === 'RUB'));
    });
});
