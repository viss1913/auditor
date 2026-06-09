const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    rankProfiles,
    buildSheetContext,
    resolveSheetProfiles,
    DETECT_THRESHOLD,
} = require('./sheet_parse_orchestrator');

const FIXTURE = path.join(__dirname, '..', 'docs', 'Anton', 'Пример по сч 76.xlsx');

describe('sheet_parse_orchestrator', () => {
    const buf = fs.readFileSync(FIXTURE);
    const file = { buffer: buf, originalname: 'Пример по сч 76.xlsx' };

    it('rankProfiles: Обработанная ОСВ → osv_flat выше catalog', () => {
        const ctx = buildSheetContext({ pool: null, file, sheetName: 'Обработанная ОСВ' });
        const ranked = rankProfiles(ctx);
        assert.ok(ranked.length >= 2);
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
});
