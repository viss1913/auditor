const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildParseValidationReport } = require('./parse_validation_report');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { classifySheetStructure } = require('./structure_classifier');
const { parseKsSheet } = require('./ks_sheet_martin');

const FIXTURES = path.join(__dirname, 'fixtures');
const JOURNAL_FIXTURE = path.join(FIXTURES, 'tricky', 'journal', 'card_76_07_6.xlsx');

function loadJournalFixture() {
    if (!fs.existsSync(JOURNAL_FIXTURE)) return null;
    const buf = fs.readFileSync(JOURNAL_FIXTURE);
    const loaded = readSheetWithMeta(buf, null, { useExcelProbe: true });
    const structure = classifySheetStructure(loaded.data || [], {
        hasOutline: loaded.hasOutline,
        rowOutlineLevels: loaded.rowOutlineLevels,
        mergedRanges: loaded.mergedRanges,
    });
    const parsed = parseKsSheet(buf);
    const preview = {
        ok: true,
        headers: parsed.headers,
        rows: parsed.rows.slice(0, 5),
        rowCount: parsed.rows.length,
    };
    return { structure, preview, scenarioId: parsed.scenarioId };
}

describe('parse_validation_report', () => {
    it('journal_card_76_07_6 → all checks pass', () => {
        const ctx = loadJournalFixture();
        if (!ctx) return;
        const report = buildParseValidationReport({
            structure: ctx.structure,
            scenarioId: ctx.scenarioId,
            preview: ctx.preview,
        });
        assert.equal(ctx.structure.structure_id, 'journal_1c');
        assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status !== 'pass')));
        assert.equal(report.level, 'pass');
    });

    it('journal_1c + OS01 headers → fail', () => {
        const report = buildParseValidationReport({
            structure: { structure_id: 'journal_1c', signals: { dateCol0Ratio: 0 } },
            scenarioId: 'ks_card_composite_raw',
            preview: {
                ok: true,
                rowCount: 10,
                headers: ['Год', 'Тип', 'Остаточная стоимость'],
                rows: [{ Год: '2024', Тип: 'ОС' }],
            },
        });
        assert.equal(report.ok, false);
        assert.ok(report.checks.some((c) => c.id === 'journal_headers' && c.status === 'fail'));
    });

    it('probe dates without period column → not pass', () => {
        const report = buildParseValidationReport({
            structure: {
                structure_id: 'journal_1c',
                signals: { dateCol0Ratio: 12 },
            },
            scenarioId: 'ks_card_composite_raw',
            preview: {
                ok: true,
                rowCount: 10,
                headers: ['Документ', 'Сумма'],
                rows: [{ Документ: 'ПКО-1', Сумма: '100' }],
            },
        });
        assert.equal(report.ok, false);
        assert.ok(report.checks.some((c) => c.id === 'probe_dates' && c.status !== 'pass'));
    });

    it('uk_journal_58 + uk_card headers → pass (не journal_1c checks)', () => {
        const report = buildParseValidationReport({
            structure: { structure_id: 'uk_journal_58', signals: { dateCol0Ratio: 50 } },
            scenarioId: 'uk_card',
            preview: {
                ok: true,
                rowCount: 10,
                headers: [
                    'period',
                    'document',
                    'amount',
                    'quantity',
                    'debit_account',
                    'credit_account',
                    'current_balance_bu',
                    'current_balance_qty',
                ],
                rows: [
                    {
                        period: '01.01.2024',
                        amount: 100,
                        quantity: 5,
                        current_balance_bu: 1000,
                        current_balance_qty: 500,
                    },
                ],
            },
        });
        assert.equal(report.ok, true);
        assert.ok(report.checks.some((c) => c.id === 'uk_card_headers' && c.status === 'pass'));
        assert.ok(report.checks.some((c) => c.id === 'uk_card_balance_columns' && c.status === 'pass'));
        assert.ok(!report.checks.some((c) => c.id === 'journal_headers'));
    });

    it('scenario misalignment journal + os_01 → fail', () => {
        const report = buildParseValidationReport({
            structure: { structure_id: 'journal_1c', signals: {} },
            scenarioId: 'os_01_hierarchy',
            preview: {
                ok: true,
                rowCount: 10,
                headers: ['Период', 'Документ', 'Счёт Дт', 'Сумма Дт'],
                rows: [{ Период: '01.01.2024' }],
            },
        });
        assert.equal(report.ok, false);
        assert.ok(report.checks.some((c) => c.id === 'scenario_alignment' && c.status === 'fail'));
    });

    it('target compare fails when columns diverge', () => {
        const report = buildParseValidationReport({
            structure: { structure_id: 'hierarchy_os_01', signals: {} },
            scenarioId: 'os_01_hierarchy',
            preview: {
                ok: true,
                rowCount: 5,
                headers: ['ColA', 'ColB'],
                rows: [{ ColA: 'x', ColB: 'y' }],
            },
            target: {
                headers: ['ОС', 'Группа', 'Стоимость', 'Амортизация'],
                rows: [{ ОС: 'Компьютер', Группа: 'IT', Стоимость: 100, Амортизация: 10 }],
            },
        });
        assert.equal(report.ok, false);
        assert.ok(report.checks.some((c) => c.id === 'target_columns' && c.status === 'fail'));
    });
});
