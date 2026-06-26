const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    rankProfiles,
    buildSheetContext,
    resolveSheetProfiles,
    buildValidationReportForResult,
    DETECT_THRESHOLD,
} = require('./sheet_parse_orchestrator');
const { parseKsSheet } = require('./ks_sheet_martin');

const FIXTURE = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('sheet_parse_orchestrator', () => {
    const buf = fs.readFileSync(FIXTURE);
    const file = { buffer: buf, originalname: 'Пример по сч 76.xlsx' };

    it('rankProfiles: Обработанная ОСВ → flat_osv / osv_flat_processed', () => {
        const ctx = buildSheetContext({ pool: null, file, sheetName: 'Обработанная ОСВ' });
        const ranked = rankProfiles(ctx);
        assert.equal(ctx.structure.structure_id, 'flat_osv');
        assert.ok(ctx.structure.autoParse);
        assert.ok(ranked.length >= 1);
        assert.equal(ranked[0].profile.id, 'osv_flat_processed');
        assert.ok(ranked[0].score >= DETECT_THRESHOLD);
    });

    it('rankProfiles: Исходная КС → ks_card первый', () => {
        const ctx = buildSheetContext({ pool: null, file, sheetName: 'Исходная КС' });
        const ids = resolveSheetProfiles(ctx).map((p) => p.id);
        assert.equal(ids[0], 'ks_card');
    });

    it('rankProfiles: Исходная ОСВ → catalog (дерево)', () => {
        const ctx = buildSheetContext({ pool: null, file, sheetName: 'Исходная ОСВ' });
        const ids = resolveSheetProfiles(ctx).map((p) => p.id);
        assert.ok(ids.includes('catalog_scenario'));
        assert.ok(!ids.includes('osv_flat_processed') || rankProfiles(ctx).find((r) => r.profile.id === 'osv_flat_processed')?.score < 0.85);
    });

    it('validationReport: Исходная КС preview → ok', () => {
        const ctx = buildSheetContext({ pool: null, file, sheetName: 'Исходная КС' });
        const parsed = parseKsSheet(buf, 'Исходная КС');
        assert.ok(parsed?.rows?.length);
        const report = buildValidationReportForResult(ctx, {
            ok: true,
            scenarioId: parsed.scenarioId,
            profileId: 'ks_card',
            parsePreview: {
                ok: true,
                headers: parsed.headers,
                rows: parsed.rows.slice(0, 3),
                rowCount: parsed.rows.length,
            },
        });
        assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status !== 'pass')));
    });

    it('uk_card_mechel → uk_card profile, БУ+Кол в одной строке', async () => {
        const { applyScenario } = require('./scenarios/registry');
        const { runParsePreview, withTempFile } = require('./parse_preview');
        const mechel = path.join(__dirname, 'fixtures', 'uk_card_mechel.xlsx');
        if (!fs.existsSync(mechel)) return;
        const buf = fs.readFileSync(mechel);
        const ctx = buildSheetContext({
            pool: null,
            file: { buffer: buf, originalname: 'карт 58.1_HP.xlsx' },
            sheetName: 'TDSheet',
            projectId: 1,
        });
        const ranked = rankProfiles(ctx);
        assert.equal(ranked[0]?.profile.id, 'uk_card');
        assert.equal(ctx.structure.structure_id, 'uk_journal_58');
        assert.equal(ctx.structure.autoParse, true);

        const rule = applyScenario('uk_card', ctx.layoutMeta);
        const preview = withTempFile(buf, 'карт 58.1_HP.xlsx', (tmp) => runParsePreview(tmp, rule, 20));
        assert.equal(preview.ok, true);
        assert.ok(preview.rowCount >= 3);
        const withQty = (preview.rows || []).find((r) => r.quantity === 10 && r.amount === 1083.5);
        assert.ok(withQty, 'БУ и Кол. должны быть в одной строке');

        const report = buildValidationReportForResult(ctx, {
            ok: true,
            scenarioId: 'uk_card',
            profileId: 'uk_card',
            parsePreview: preview,
        });
        assert.equal(report.ok, true, JSON.stringify(report.checks.filter((c) => c.status !== 'pass')));
    });

    it('buildSheetContext: structurePack с ontology', () => {
        const mechel = path.join(__dirname, 'fixtures', 'uk_card_mechel.xlsx');
        if (!fs.existsSync(mechel)) return;
        const buf = fs.readFileSync(mechel);
        const ctx = buildSheetContext({
            pool: null,
            file: { buffer: buf, originalname: 'карт 58.1_HP.xlsx' },
            sheetName: 'TDSheet',
        });
        assert.ok(ctx.structurePack);
        assert.equal(ctx.structurePack.ontology.row_pattern, 'bu_kol_pairs');
        assert.ok(ctx.structurePack.scenario_catalog?.length >= 14);
        assert.ok(ctx.structurePack.uk_probe?.debit_account_column != null);
    });
});
