const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const xlsx = require('xlsx');

const { runParseEngine } = require('./parse_engine');

function writeTempXlsx(rows) {
    const tmp = path.join(os.tmpdir(), `auditor_composite_${Date.now()}.xlsx`);
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    xlsx.writeFile(wb, tmp);
    return tmp;
}

describe('parse_engine: composite_cell source.type', () => {
    it('извлекает инвентарный номер и дату из составной ячейки', () => {
        const compositeText = 'Блок-контейнер…, 000002272, 01.10.2018 (санузел)';
        const leafName = 'Неотделимые улучшения 000002272 доп текст для порога';

        const rows = [
            ['Ведомость амортизации за 2024 г', '', '', ''],
            ['Здания', '', '', ''],
            ['КЦ', '', '', ''],
            ['ОП КЦ', '', '', ''],
            // leaf row: name in col0, numeric in col1, composite in col2
            [leafName, 123, compositeText, ''],
        ];

        const tmp = writeTempXlsx(rows);
        try {
            const rule = {
                rule_schema_version: 2,
                meta: { name: 'composite_cell test', source_type: 'excel', profile_hint: 'os_01' },
                layout: { layout_type: 'hierarchy_rows', name_column: 0 },
                hierarchy: { leaf_rules: {}, levels: [] },
                columns: [
                    {
                        target: 'Инвентарный номер',
                        source: {
                            type: 'composite_cell',
                            column: 2,
                            extract: { pattern: '\\d{9}', group: 0 },
                        },
                    },
                    {
                        target: 'Дата',
                        source: {
                            type: 'composite_cell',
                            column: 2,
                            extract: { pattern: '\\d{2}\\.\\d{2}\\.\\d{4}', transform: 'date_ddmmyyyy' },
                        },
                    },
                ],
                filters: {},
                output: { shape: 'wide' },
            };

            const out = runParseEngine(tmp, rule);
            assert.equal(out.ok, true);
            assert.equal(out.rowCount, 1);
            assert.equal(out.rows[0]['Инвентарный номер'], '000002272');
            assert.equal(out.rows[0]['Дата'], '2018-10-01');
        } finally {
            try {
                require('fs').unlinkSync(tmp);
            } catch {}
        }
    });
});

