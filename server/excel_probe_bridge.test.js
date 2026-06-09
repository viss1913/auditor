const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { expandMergedCells } = require('./excel_sheet_meta');
const { probeExcelFile, canProbeExtension } = require('./excel_probe_bridge');

describe('excel_probe integration', () => {
    it('expandMergedCells fills merged range from top-left', () => {
        const data = [
            ['ОАО Тест', '', ''],
            ['Группа', 100, 200],
        ];
        const out = expandMergedCells(data, ['A1:C1']);
        assert.equal(out[0][1], 'ОАО Тест');
        assert.equal(out[0][2], 'ОАО Тест');
    });

    it('canProbeExtension accepts xlsx/xlsm only', () => {
        assert.equal(canProbeExtension('file.xlsx'), true);
        assert.equal(canProbeExtension('file.xlsm'), true);
        assert.equal(canProbeExtension('file.xls'), false);
    });

    it('probeExcelFile returns outline/style metadata for fixture', () => {
        const fixture = path.join(__dirname, 'fixtures', 'Пример по сч 76.xlsx');
        if (!fs.existsSync(fixture)) return;

        const probe = probeExcelFile(fixture);
        if (!probe) return;

        assert.equal(probe.ok, true);
        assert.ok(Array.isArray(probe.row_outline_levels));
        assert.ok(probe.style_hints);
        assert.ok(Array.isArray(probe.merged_ranges));
    });
});
