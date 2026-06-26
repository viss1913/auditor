const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildReasoningTrace } = require('./reasoning_trace');

describe('reasoning_trace', () => {
    it('план + структура uk_osv_58', () => {
        const trace = buildReasoningTrace({
            parsePlan: {
                summary: 'сценарий uk_osv_58',
                scenarioId: 'uk_osv_58',
                confidence: 0.85,
                intent: 'parse_sheet',
            },
            structure: {
                structure_id: 'uk_osv_58',
                confidence: 0.96,
                fingerprint_reason: 'title58 buKol=11',
                autoParse: true,
                ambiguous: false,
                alternatives: [{ structure_id: 'hierarchy_os_01', confidence: 0.9 }],
            },
            profileId: 'uk_osv_58',
            scenarioId: 'uk_osv_58',
            rowCount: 8,
            tableMeta: { tableLayout: 'uk_osv_wide' },
            outcome: 'success',
            fileName: 'ОСВ 58.01.7.xlsx',
            sheetName: 'TDSheet',
        });
        assert.equal(trace.outcome, 'success');
        assert.ok(trace.steps.some((s) => s.id === 'structure' && s.detail.includes('uk_osv_58')));
        assert.ok(trace.steps.some((s) => s.id === 'result' && s.detail.includes('uk_osv_wide')));
    });

    it('отказ ambiguous', () => {
        const trace = buildReasoningTrace({
            structure: {
                structure_id: 'hierarchy_os_01',
                confidence: 0.9,
                ambiguous: true,
                autoParse: false,
                alternatives: [{ structure_id: 'flat_osv', confidence: 0.88 }],
            },
            outcome: 'refused',
            reason: 'ambiguous_structure',
        });
        assert.equal(trace.steps.find((s) => s.id === 'structure').status, 'warn');
        assert.equal(trace.steps.find((s) => s.id === 'refusal').status, 'fail');
    });
});
