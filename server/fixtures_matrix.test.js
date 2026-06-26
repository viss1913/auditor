const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveUpload } = require('./scenario_router');
const { classifySheetStructure } = require('./structure_classifier');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { parseKsSheet } = require('./ks_sheet_martin');
const { parseUkOsv58Sheet } = require('./uk_osv_martin');
const { applyScenario } = require('./scenarios/registry');
const { runParsePreview, withTempFile } = require('./parse_preview');
const { runParseEngine } = require('./parse_engine');
const { comparePreviewToTarget, loadTargetRows } = require('./compare_target');
const { applyTargetToRule } = require('./target_rule_infer');

const FIXTURES = path.join(__dirname, 'fixtures');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));

const TEST_TIERS = new Set(['P0', 'P1', 'P2', 'REF']);

function fixturePath(entry) {
    return path.join(FIXTURES, entry.file);
}

async function resolveFixture(entry) {
    const fp = fixturePath(entry);
    if (!fs.existsSync(fp)) {
        if (entry.optional) return null;
        throw new Error(`Fixture missing: ${fp}`);
    }
    const buf = fs.readFileSync(fp);
    const fileName = entry.fileNameHint || path.basename(fp);
    return resolveUpload({
        buffer: buf,
        fileName,
        sheetName: entry.sheetName,
        orchestratorAnswers: entry.orchestratorAnswers || {},
    });
}

async function parseFixture(entry) {
    const fp = fixturePath(entry);
    const buf = fs.readFileSync(fp);
    const fileName = entry.fileNameHint || path.basename(fp);
    const routed = await resolveUpload({
        buffer: buf,
        fileName,
        sheetName: entry.sheetName,
        orchestratorAnswers: entry.orchestratorAnswers || {},
    });
    const scenarioId = entry.orchestratorAnswers?.scenarioId || entry.expectedScenario || routed.scenarioId;
    const rule = applyScenario(scenarioId, routed.layoutMeta, null);
    const preview = withTempFile(buf, fileName, (tmp) => runParsePreview(tmp, rule, 500));
    return { routed, rule, preview };
}

function assertRowCount(preview, entry) {
    if (entry.expectedRowCountMin == null && entry.expectedRowCountMax == null) return;
    const count = preview.rowCount ?? preview.rows?.length ?? 0;
    if (entry.expectedRowCountMin != null) {
        assert.ok(
            count >= entry.expectedRowCountMin,
            `${entry.id}: rowCount ${count} < min ${entry.expectedRowCountMin}`
        );
    }
    if (entry.expectedRowCountMax != null) {
        assert.ok(
            count <= entry.expectedRowCountMax,
            `${entry.id}: rowCount ${count} > max ${entry.expectedRowCountMax}`
        );
    }
}

function assertColumns(preview, entry) {
    for (const col of entry.mustHaveColumns || []) {
        assert.ok(
            preview.headers?.includes(col),
            `${entry.id}: missing column «${col}», got ${preview.headers?.join(', ')}`
        );
    }
}

function assertMustHaveRow(preview, entry) {
    if (!entry.mustHaveRow || !preview.rows?.length) return;
    for (const [col, fragment] of Object.entries(entry.mustHaveRow)) {
        const hit = preview.rows.some((r) => String(r[col] ?? '').includes(fragment));
        assert.ok(hit, `${entry.id}: no row with ${col} containing «${fragment}»`);
    }
}

const activeFixtures = MANIFEST.fixtures.filter(
    (f) => TEST_TIERS.has(f.tier) && f.testParse !== false
);

const structureFixtures = MANIFEST.fixtures.filter(
    (f) => TEST_TIERS.has(f.tier) && f.expectedStructure
);

describe('fixtures_matrix structure', () => {
    for (const entry of structureFixtures) {
        it(`${entry.id} → structure ${entry.expectedStructure}`, () => {
            const fp = fixturePath(entry);
            if (!fs.existsSync(fp)) {
                if (entry.optional) return;
                assert.fail(`missing ${fp}`);
            }
            const buf = fs.readFileSync(fp);
            const loaded = readSheetWithMeta(buf, entry.sheetName, { useExcelProbe: true });
            const structure = classifySheetStructure(loaded.data, {
                hasOutline: loaded.hasOutline,
                rowOutlineLevels: loaded.rowOutlineLevels,
            });
            assert.equal(
                structure.structure_id,
                entry.expectedStructure,
                `${entry.id}: structure ${structure.structure_id} !== ${entry.expectedStructure} (${structure.fingerprint_reason})`
            );
            assert.equal(structure.autoParse, true, `${entry.id}: autoParse false`);
        });
    }

    it('journal_card_76_07_6 → ks parse rows', () => {
        const entry = MANIFEST.fixtures.find((f) => f.id === 'journal_card_76_07_6');
        const fp = fixturePath(entry);
        const buf = fs.readFileSync(fp);
        const parsed = parseKsSheet(buf, entry.sheetName);
        assert.ok(parsed?.rows?.length >= entry.expectedRowCountMin);
        assert.equal(parsed.scenarioId, entry.expectedScenario);
        assertColumns({ headers: parsed.headers, rows: parsed.rows }, entry);
    });

    for (const entry of MANIFEST.fixtures.filter((f) => f.testUkOsvParse)) {
        it(`${entry.id} → uk_osv_58 parse rows`, () => {
            const fp = fixturePath(entry);
            if (!fs.existsSync(fp)) {
                if (entry.optional) return;
                assert.fail(`missing ${fp}`);
            }
            const buf = fs.readFileSync(fp);
            const loaded = readSheetWithMeta(buf, entry.sheetName, { useExcelProbe: true });
            const parsed = parseUkOsv58Sheet(loaded.data);
            assert.ok(parsed?.rows?.length, `${entry.id}: no rows`);
            assert.equal(parsed.scenarioId, entry.expectedScenario || 'uk_osv_58');
            assertRowCount({ rowCount: parsed.rows.length, rows: parsed.rows }, entry);
            assertColumns({ headers: parsed.headers, rows: parsed.rows }, entry);
            assertMustHaveRow({ headers: parsed.headers, rows: parsed.rows }, entry);
        });
    }
});

describe('fixtures_matrix routing', () => {
    for (const entry of activeFixtures.filter((f) => !f.testRouteOnly)) {
        it(`${entry.id} [${entry.tier}] → route + scenario`, async () => {
            const routed = await resolveFixture(entry);
            if (!routed) return;
            assert.equal(routed.ok, true, `${entry.id}: resolveUpload failed`);
            if (entry.expectedScenario) {
                const scenarioId =
                    entry.orchestratorAnswers?.scenarioId || routed.scenarioId;
                assert.ok(
                    scenarioId === entry.expectedScenario ||
                        routed.scenarioId === entry.expectedScenario,
                    `${entry.id}: expected ${entry.expectedScenario}, got ${routed.scenarioId}`
                );
            }
        });
    }
});

describe('fixtures_matrix parse', () => {
    for (const entry of activeFixtures.filter((f) => f.testParse && !f.testRouteOnly)) {
        it(`${entry.id} [${entry.tier}] parse preview`, async () => {
            const fp = fixturePath(entry);
            if (!fs.existsSync(fp)) {
                if (entry.optional) return;
                assert.fail(`missing ${fp}`);
            }
            let result;
            try {
                result = await parseFixture(entry);
            } catch (e) {
                if (entry.allowParseFail) return;
                throw e;
            }
            const { preview } = result;
            if (!preview.ok) {
                if (entry.allowParseFail) return;
                assert.fail(`${entry.id}: parse failed: ${JSON.stringify(preview.errors || preview)}`);
            }
            assertRowCount(preview, entry);
            assertColumns(preview, entry);
            assertMustHaveRow(preview, entry);
        });
    }
});

describe('fixtures_matrix from_target', () => {
    const entry = MANIFEST.fixtures.find((f) => f.id === 'from_target_source');
    if (!entry) return;

    it('from_target: infer + compare with etalon', async () => {
        const srcPath = fixturePath(entry);
        const tgtPath = path.join(FIXTURES, entry.targetFile);
        if (!fs.existsSync(srcPath) || !fs.existsSync(tgtPath)) return;

        const targetRows = loadTargetRows(fs.readFileSync(tgtPath));
        assert.ok(targetRows.headers?.length >= 3);

        const buf = fs.readFileSync(srcPath);
        const routed = await resolveUpload({
            buffer: buf,
            fileName: path.basename(srcPath),
            sheetName: entry.sheetName,
        });

        const baseRule = applyScenario('os_01_hierarchy', routed.layoutMeta, null);
        const rule = applyTargetToRule(baseRule, targetRows, routed.layoutMeta?.column_catalog);
        const out = withTempFile(buf, path.basename(srcPath), (tmp) => runParsePreview(tmp, rule, 100));
        assert.equal(out.ok, true);
        assert.ok(out.rowCount >= 1);

        const cmp = comparePreviewToTarget(out, targetRows);
        assert.ok(cmp.summary?.matched >= 1, `matched=${cmp.summary?.matched}`);
    });
});

describe('fixtures_matrix P0 smoke list', () => {
    it('all P0 fixtures exist on disk', () => {
        const p0 = MANIFEST.fixtures.filter((f) => f.tier === 'P0');
        const missing = p0.filter((f) => !fs.existsSync(fixturePath(f))).map((f) => f.id);
        assert.deepEqual(missing, [], `Missing P0: ${missing.join(', ')}`);
    });
});
