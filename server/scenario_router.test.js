const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const xlsx = require('xlsx');
const { resolveUpload } = require('./scenario_router');
const { buildSessionPlan } = require('./orchestrator/session_plan');
const { applyScenario } = require('./scenarios/registry');
const { runParsePreview, withTempFile } = require('./parse_preview');

const FIXTURES = path.join(__dirname, 'fixtures');
const UK581 = path.join(FIXTURES, 'uk_card_581.xlsx');
const UK_SAMPLE = path.join(FIXTURES, 'uk_sample.xlsx');
const OS76 = path.join(FIXTURES, 'Пример по сч 76.xlsx');
const OS76_TRICKY = path.join(FIXTURES, 'tricky', 'os_76', 'os76_card_clean.xlsx');
const DEALS_TXT = path.join(FIXTURES, 'deals_registry_sample.txt');
const FAS_XLSX = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');

if (!fs.existsSync(UK581)) {
    execSync('node generate_uk_card_581.js', { cwd: FIXTURES, stdio: 'ignore' });
}

const UPD_PAVEL = path.join(__dirname, '..', 'docs', 'Павел', 'UPD_69_2025-01-09 [Xg9AgY].pdf');

describe('scenario_router', () => {
    it('uk_card_581 → uk_card без дерева', async () => {
        const buf = fs.readFileSync(UK581);
        const routed = await resolveUpload({
            buffer: buf,
            fileName: 'карт 58.1_HP.xlsx',
            sheetName: 'TDSheet',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.route, 'excel');
        assert.equal(routed.scenarioId, 'uk_card');
        assert.equal(routed.needsTreeConfirm, false);
    });

    it('uk_card: session_plan без pick_tree_flatten + парс строк', async () => {
        const buf = fs.readFileSync(UK_SAMPLE);
        const routed = await resolveUpload({
            buffer: buf,
            fileName: 'карт 58.1_HP.xlsx',
        });
        const plan = buildSessionPlan(routed.layoutMeta, null, null, {
            scenarioIdParam: routed.scenarioId,
            answers: {},
            savedRules: [],
        });
        assert.equal(plan.needsUserInput, false);
        assert.ok(!plan.pendingQuestions.some((q) => q.id === 'pick_tree_flatten'));

        const rule = applyScenario('uk_card', routed.layoutMeta, null);
        const preview = withTempFile(buf, 'карт 58.1_HP.xlsx', (tmp) => runParsePreview(tmp, rule, 50));
        assert.equal(preview.ok, true);
        assert.ok(preview.rowCount > 0);
        assert.ok(preview.headers.includes('name') || preview.headers.includes('period'));
    });

    it('os_01 flat: resolve + preview rows', async () => {
        if (!fs.existsSync(FAS_XLSX)) return;
        const buf = fs.readFileSync(FAS_XLSX);
        const routed = await resolveUpload({
            buffer: buf,
            fileName: 'Пример для ТЗ ФАС- ОС.xlsx',
            sheetName: 'Исходная выгрузка 01',
            orchestratorAnswers: { scenarioId: 'os_01_flat' },
        });
        const rule = applyScenario('os_01_flat', routed.layoutMeta, null);
        const preview = withTempFile(buf, 'fas.xlsx', (tmp) => runParsePreview(tmp, rule, 30));
        assert.equal(preview.ok, true);
        assert.ok(preview.rowCount > 0);
    });

    it('os_08_osv: synthetic fixture detect', async () => {
        const rows = [
            ['08', '', '', '', '', '', '', ''],
            ['Подразделение Центр', '', '', '', '', '', '', ''],
            ['Объект ОС-1', '', '', '', 100, 50, 200, 80],
        ];
        const ws = xlsx.utils.aoa_to_sheet(rows);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'ОСВ 08');
        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const routed = await resolveUpload({
            buffer: buf,
            fileName: 'осв_08.xlsx',
            sheetName: 'ОСВ 08',
        });
        assert.equal(routed.scenarioId, 'os_08_osv');
    });

    it('UPD pdf → upd_ediweb not opif_depo', async () => {
        if (!fs.existsSync(UPD_PAVEL)) return;
        const buf = fs.readFileSync(UPD_PAVEL);
        const routed = await resolveUpload({ buffer: buf, fileName: 'UPD_69.pdf' });
        assert.equal(routed.ok, true);
        assert.equal(routed.scenarioId, 'upd_ediweb');
        assert.equal(routed.route, 'universal_pdf');
    });

    it('deals_registry txt → deals_registry_tsv', async () => {
        const buf = fs.readFileSync(DEALS_TXT);
        const routed = await resolveUpload({
            buffer: buf,
            fileName: 'реестр_сделок.txt',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.route, 'text');
        assert.equal(routed.scenarioId, 'deals_registry_tsv');
        assert.equal(routed.textParse.rowCount, 3);
    });

    it('FAS 01 → needsUserChoice flat vs hierarchy', async () => {
        if (!fs.existsSync(FAS_XLSX)) return;
        const buf = fs.readFileSync(FAS_XLSX);
        const routed = await resolveUpload({
            buffer: buf,
            fileName: 'Пример для ТЗ ФАС- ОС.xlsx',
            sheetName: 'Исходная выгрузка 01',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.needsUserChoice, true);
    });

    it('os_76 fixture → os_76_account_card + tree confirm', async () => {
        const os76Path = fs.existsSync(OS76_TRICKY) ? OS76_TRICKY : OS76;
        if (!fs.existsSync(os76Path)) return;
        const buf = fs.readFileSync(os76Path);
        const routed = await resolveUpload({
            buffer: buf,
            fileName: path.basename(os76Path),
            sheetName: 'Исходная ОСВ',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.scenarioId, 'os_76_account_card');
    });
});
