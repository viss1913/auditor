const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { smartParseOS, loadRuleFromFile } = require('./smart_parse_os');
const { validateOsRuleJson } = require('./os_rule_validate');

const sampleXlsx = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');
const rule01 = path.join(__dirname, 'rules', 'fas_os_01.json');
const rule08 = path.join(__dirname, 'rules', 'fas_os_08.json');

describe('validateOsRuleJson', () => {
    it('принимает правило 01', () => {
        const r = validateOsRuleJson(loadRuleFromFile(rule01));
        assert.equal(r.ok, true);
    });

    it('отклоняет без variant', () => {
        const r = validateOsRuleJson({ source: 'x' });
        assert.equal(r.ok, false);
    });
});

describe('smartParseOS на примере ФАС', () => {
    it('01: плоская таблица как мэппинг (Группа, ОП, ОС, год)', () => {
        const rule = loadRuleFromFile(rule01);
        const { rows, headers } = smartParseOS(sampleXlsx, rule);
        assert.ok(rows.length >= 15, `ожидали >=15 строк, получили ${rows.length}`);
        assert.ok(headers.includes('Группа'));
        assert.ok(headers.includes('ОС'));
        assert.ok(headers.some((h) => /2024 - начало/.test(h)));
        const sample = rows.find((r) => /80-000722/.test(r['ОС']));
        assert.ok(sample, 'должен быть модульное здание 80-000722');
        assert.equal(sample['Группа'], 'Здания');
        assert.ok(sample['2024 - амортизация'] !== null && sample['2024 - амортизация'] !== '');
    });

    it('01: output_metrics без амортизации — только стоимость', () => {
        const rule = {
            ...loadRuleFromFile(rule01),
            output_metrics: [
                { field: 'cost_open', column_label: 'стоимость на начало' },
                { field: 'cost_close', column_label: 'стоимость на конец' },
            ],
        };
        const { rows, headers } = smartParseOS(sampleXlsx, rule);
        assert.ok(!headers.some((h) => /амортизация/i.test(h)));
        assert.ok(headers.includes('2024 - стоимость на начало'));
        assert.ok(headers.includes('2024 - стоимость на конец'));
        assert.ok(rows.length >= 15);
    });

    it('08: вытаскивает обороты по объектам', () => {
        const rule = loadRuleFromFile(rule08);
        const { rows } = smartParseOS(sampleXlsx, rule);
        assert.ok(rows.length >= 3, `ожидали >=3 строк, получили ${rows.length}`);
        const srv = rows.find((r) => /80-000662/.test(r['Объект']));
        assert.ok(srv);
        assert.equal(srv['Год'], '2023');
        assert.equal(srv['Оборот Дт'], 19300);
    });
});
