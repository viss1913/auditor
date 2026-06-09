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
const DEALS_TXT = path.join(FIXTURES, 'deals_registry_sample.txt');
const FAS_XLSX = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');

if (!fs.existsSync(UK581)) {
    execSync('node generate_uk_card_581.js', { cwd: FIXTURES, stdio: 'ignore' });
}

describe('scenario_router', () => {
    it('uk_card_581 → uk_card без дерева', () => {
        const buf = fs.readFileSync(UK581);
        const routed = resolveUpload({
            buffer: buf,
            fileName: 'карт 58.1_HP.xlsx',
            sheetName: 'TDSheet',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.route, 'excel');
        assert.equal(routed.scenarioId, 'uk_card');
        assert.equal(routed.needsTreeConfirm, false);
    });

    it('uk_card: session_plan без pick_tree_flatten + парс строк', () => {
        const buf = fs.readFileSync(UK_SAMPLE);
        const routed = resolveUpload({
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

    it('os_01 flat: resolve + preview rows', () => {
        if (!fs.existsSync(FAS_XLSX)) return;
        const buf = fs.readFileSync(FAS_XLSX);
        const routed = resolveUpload({
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

    it('os_08_osv: synthetic fixture detect', () => {
        const rows = [
            ['08', '', '', '', '', '', '', ''],
            ['Подразделение Центр', '', '', '', '', '', '', ''],
            ['Объект ОС-1', '', '', '', 100, 50, 200, 80],
        ];
        const ws = xlsx.utils.aoa_to_sheet(rows);
        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, ws, 'ОСВ 08');
        const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const routed = resolveUpload({
            buffer: buf,
            fileName: 'осв_08.xlsx',
            sheetName: 'ОСВ 08',
        });
        assert.equal(routed.scenarioId, 'os_08_osv');
    });

    it('deals_registry txt → deals_registry_tsv', () => {
        const buf = fs.readFileSync(DEALS_TXT);
        const routed = resolveUpload({
            buffer: buf,
            fileName: 'реестр_сделок.txt',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.route, 'text');
        assert.equal(routed.scenarioId, 'deals_registry_tsv');
        assert.equal(routed.textParse.rowCount, 3);
    });

    it('FAS 01 → needsUserChoice flat vs hierarchy', () => {
        if (!fs.existsSync(FAS_XLSX)) return;
        const buf = fs.readFileSync(FAS_XLSX);
        const routed = resolveUpload({
            buffer: buf,
            fileName: 'Пример для ТЗ ФАС- ОС.xlsx',
            sheetName: 'Исходная выгрузка 01',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.needsUserChoice, true);
    });

    it('os_76 fixture → os_76_account_card + tree confirm', () => {
        if (!fs.existsSync(OS76)) return;
        const buf = fs.readFileSync(OS76);
        const routed = resolveUpload({
            buffer: buf,
            fileName: 'Пример по сч 76.xlsx',
        });
        assert.equal(routed.ok, true);
        assert.equal(routed.scenarioId, 'os_76_account_card');
        assert.equal(routed.needsTreeConfirm, true);
    });
});
