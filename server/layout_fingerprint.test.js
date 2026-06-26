const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildLayoutFingerprint, scoreProfileCandidates } = require('./layout_fingerprint');
const { buildOS01HierarchyRows } = require('./fixtures/generators/node/os01_base');

function revenueSample() {
    return [
        ['Выручка', '', '', '', '', '', ''],
        ['ООО Тест', '', '', '', '', '', ''],
        ['', 'На начало периода', '', 'За период', '', 'На конец периода', ''],
        ['', 'Сальдо Дт', 'Сальдо Кт', 'Оборот Дт', 'Оборот Кт', 'Сальдо Дт', 'Сальдо Кт'],
        ['90.01.1, Выручка по деятельности', 100, 0, 500, 500, 600, 0],
        ['90.02.1, Себестоимость', 50, 0, 200, 200, 250, 0],
    ];
}

function ukSample() {
    const rows = Array(8).fill(['', '', '', '', '', '', '', '']);
    for (let i = 0; i < 5; i++) {
        const d = `0${i + 1}.03.2024`;
        rows.push([d, '', '', '', '', 'БУ', '58.01', '1000', '']);
        rows.push([d, '', '', '', '', 'Кол.', '', '10', '']);
    }
    return rows;
}

describe('layout_fingerprint', () => {
    it('ОС 01: hierarchy_rows, не revenue', () => {
        const data = buildOS01HierarchyRows();
        const fp = buildLayoutFingerprint(data, { fileName: 'os01.xlsx', sheetName: 'Лист1' });
        const candidates = scoreProfileCandidates(fp);
        assert.equal(candidates[0].profile_hint, 'os_depreciation_01');
        assert.ok(!candidates.some((c) => c.profile_hint === 'revenue_period' && c.confidence > 0.8));
    });

    it('Выручка 90: revenue_period, не os_depreciation_01', () => {
        const data = revenueSample();
        const fp = buildLayoutFingerprint(data, { fileName: 'Выручка.xlsx', sheetName: 'РД_АП' });
        const candidates = scoreProfileCandidates(fp);
        assert.equal(candidates[0].profile_hint, 'revenue_period');
        assert.ok(candidates[0].confidence >= 0.9);
    });

    it('УК: uk_card по структуре дат и БУ/Кол', () => {
        const data = ukSample();
        const fp = buildLayoutFingerprint(data, { fileName: 'uk.xlsx' });
        const candidates = scoreProfileCandidates(fp);
        assert.equal(candidates[0].profile_hint, 'uk_card');
    });

    it('fingerprint_reason заполнен', () => {
        const fp = buildLayoutFingerprint(revenueSample(), {});
        const top = scoreProfileCandidates(fp)[0];
        assert.ok(top.fingerprint_reason);
    });
});
