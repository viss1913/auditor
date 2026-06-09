const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { runParseEngine, loadExampleRule } = require('./parse_engine');
const { smartParseOS, loadRuleFromFile } = require('./smart_parse_os');
const { validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const sampleXlsx = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');
const rule01v1 = path.join(__dirname, 'rules', 'fas_os_01.json');

describe('ParsingRule v2', () => {
    it('валидирует пример иерархии 01', () => {
        const rule = loadExampleRule('os_hierarchy_01.json');
        const v = validateParsingRuleV2(rule);
        assert.equal(v.ok, true);
    });
});

describe('parse_engine на примере ФАС', () => {
    it('01 hierarchy: не хуже smart_parse_os по числу строк', () => {
        const rule = loadExampleRule('os_hierarchy_01.json');
        const out = runParseEngine(sampleXlsx, rule);
        assert.equal(out.ok, true);
        assert.ok(out.rowCount >= 15, `v2: ${out.rowCount} строк`);
        assert.ok(out.headers.includes('ОС'));
        const sample = out.rows.find((r) => /80-000722/.test(r['ОС']));
        assert.ok(sample);
        assert.equal(sample['Группа'], 'Здания');
        assert.equal(sample['Узел'], 'РТК Волгоград');
        assert.equal(sample['Подразделение'], 'ОП АБГ-Волгоград');

        const legacy = smartParseOS(sampleXlsx, loadRuleFromFile(rule01v1));
        assert.ok(
            Math.abs(out.rowCount - legacy.rows.length) <= 2,
            `v2=${out.rowCount} legacy=${legacy.rows.length}`
        );
    });

    it('01 cost_only: без амортизации', () => {
        const rule = loadExampleRule('os_hierarchy_01_cost_only.json');
        const out = runParseEngine(sampleXlsx, rule);
        assert.equal(out.ok, true);
        assert.ok(!out.headers.some((h) => /амортизация/i.test(h)));
        assert.ok(out.headers.includes('2024 - стоимость на начало'));
    });

    it('08 hierarchy_osv', () => {
        const rule = loadExampleRule('os_hierarchy_08.json');
        const out = runParseEngine(sampleXlsx, rule);
        assert.equal(out.ok, true);
        assert.ok(out.rowCount >= 3);
        const srv = out.rows.find((r) => /80-000662/.test(r['Объект']));
        assert.ok(srv);
        assert.equal(srv['Оборот Дт'], 19300);
    });

});
