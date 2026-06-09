const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const xlsx = require('xlsx');

const { runParseEngine, loadExampleRule } = require('./parse_engine');

function buildUkCardSheet({ qtyCol }) {
    const rows = [];
    for (let i = 0; i < 7; i++) rows.push(['', '', '', '', '', '', '', '', '', '']);

    // BU row
    rows.push([
        '01.06.2025', // period (col 0)
        '',
        '',
        'Тестовая бумага, 12345678', // analytics (col 3)
        '',
        'БУ', // indicator (col 5)
        '58.01', // debit_account (col 6)
        1000.5, // amount (col 7)
        '',
        '76.01', // credit_account (col 9)
    ]);

    // Кол. row
    const qtyRow = ['', '', '', '', '', 'Кол.', '', '', '', ''];
    qtyRow[qtyCol] = 25;
    rows.push(qtyRow);

    return rows;
}

function writeTempXlsx(rows) {
    const tmp = path.join(os.tmpdir(), `auditor_uk_card_${Date.now()}.xlsx`);
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    xlsx.writeFile(wb, tmp);
    return tmp;
}

describe('parse_engine fixed_columns: УК 58.01 quantity column', () => {
    it('читает quantity из колонки H (index 7) по умолчанию', () => {
        const rule = loadExampleRule('uk_card.json');
        const tmp = writeTempXlsx(buildUkCardSheet({ qtyCol: 7 }));
        try {
            const out = runParseEngine(tmp, rule);
            assert.equal(out.ok, true);
            assert.equal(out.rowCount, 1);
            assert.equal(out.rows[0].amount, 1000.5);
            assert.equal(out.rows[0].quantity, 25);
        } finally {
            try {
                require('fs').unlinkSync(tmp);
            } catch {}
        }
    });

    it('читает quantity из колонки I (index 8) если quantity_column=8', () => {
        const rule = loadExampleRule('uk_card.json');
        rule.multi_row.quantity_column = 8;
        const tmp = writeTempXlsx(buildUkCardSheet({ qtyCol: 8 }));
        try {
            const out = runParseEngine(tmp, rule);
            assert.equal(out.ok, true);
            assert.equal(out.rowCount, 1);
            assert.equal(out.rows[0].amount, 1000.5);
            assert.equal(out.rows[0].quantity, 25);
        } finally {
            try {
                require('fs').unlinkSync(tmp);
            } catch {}
        }
    });
});

