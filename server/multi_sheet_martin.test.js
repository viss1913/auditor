const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    shouldParseAllSheets,
    parseAllExcelSheets,
    isInstructionSheet,
} = require('./multi_sheet_martin');

const FIXTURE = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('multi_sheet_martin', () => {
    it('shouldParseAllSheets: один excel с несколькими листами', () => {
        const buf = fs.readFileSync(FIXTURE);
        const file = { buffer: buf, originalname: 'Пример по сч 76.xlsx' };
        assert.equal(
            shouldParseAllSheets({ files: [file], orchestratorAnswers: {} }),
            true
        );
        assert.equal(
            shouldParseAllSheets({
                files: [file],
                orchestratorAnswers: { pick_tree_flatten: 'confirm' },
            }),
            true
        );
        assert.equal(
            shouldParseAllSheets({
                files: [file],
                orchestratorAnswers: { pick_tree_flatten: 'scenario:os_08_osv' },
            }),
            false
        );
    });

    it('isInstructionSheet распознаёт лист-пояснение', () => {
        assert.equal(
            isInstructionSheet({
                previewText: 'При выгрузке Карточек счетов все данные как и в случае с ОСВ',
                recommended: { layout_type: 'fixed_columns' },
            }),
            true
        );
        assert.equal(
            isInstructionSheet({
                previewText: 'При выгрузке ОСВ из 1С все данные',
                recommended: { layout_type: 'hierarchy_osv' },
            }),
            false
        );
        assert.equal(
            isInstructionSheet({ previewText: 'Счёт, наименование счета\tПодразделение' }),
            false
        );
        assert.equal(
            isInstructionSheet({
                sheetName: 'Исходная КС',
                previewText: 'При выгрузке Карточек счетов все данные',
                recommended: { layout_type: 'fixed_columns' },
            }),
            false
        );
    });

    it('parseAllExcelSheets: парсит листы с данными из fixture 76', async () => {
        if (!process.env.DB_NAME) {
            console.log('skip DB test: no DB_NAME');
            return;
        }
        const { Pool } = require('pg');
        require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
        const pool = new Pool({
            user: process.env.DB_USER || 'postgres',
            host: process.env.DB_HOST || 'localhost',
            database: process.env.DB_NAME,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
        });
        try {
            const buf = fs.readFileSync(FIXTURE);
            const file = { buffer: buf, originalname: 'Пример по сч 76.xlsx' };
            const result = await parseAllExcelSheets({ pool, file });
            assert.ok(result.ok);
            assert.ok(result.parsed.length >= 4, `parsed ${result.parsed.length} sheets`);
            const names = result.parsed.map((p) => p.sheetName);
            assert.ok(names.includes('Исходная ОСВ'));
            assert.ok(names.includes('Обработанная ОСВ'));
            assert.ok(names.includes('Исходная КС'));
            assert.ok(names.includes('Обработанная КС'));
            const src = result.parsed.find((p) => p.sheetName === 'Исходная ОСВ');
            assert.ok(src.rowCount >= 20);
            for (const p of result.parsed) {
                await pool.query('DELETE FROM parse_snapshots WHERE id = $1', [p.snapshotId]);
            }
        } finally {
            await pool.end();
        }
    });
});
