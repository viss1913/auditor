const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    compactLayoutMetaForClient,
    sanitizeParseApiBody,
    compactRuleForClient,
    compactReasoningTrace,
    CLIENT_PREVIEW_ROWS,
} = require('./client_response_sanitize');
const { shouldUseStructureOrchestrator } = require('./structure_autostart');

describe('client_response_sanitize', () => {
    it('strips row_outline_levels but keeps count', () => {
        const compact = compactLayoutMetaForClient({
            sheetName: 'TDSheet',
            row_outline_levels: new Array(31215).fill(0),
            hidden_row_indices: [1, 2, 3],
            structure: { structure_id: 'uk_journal_58', ranked: [{ structure_id: 'x' }] },
        });
        assert.equal(compact.row_outline_level_count, 31215);
        assert.equal(compact.row_outline_levels, undefined);
        assert.equal(compact.hidden_row_count, undefined);
    });

    it('parsePreview limited to CLIENT_PREVIEW_ROWS', () => {
        const body = sanitizeParseApiBody({
            parsePreview: {
                headers: ['a'],
                rows: Array.from({ length: 200 }, (_, i) => ({ a: i })),
                rowCount: 31215,
            },
        });
        assert.equal(body.parsePreview.rows.length, CLIENT_PREVIEW_ROWS);
        assert.equal(body.parsePreview.rowCount, 31215);
        assert.equal(body.parsePreview.previewTruncated, true);
    });

    it('sanitizeParseApiBody survives JSON.stringify on heavy layout', () => {
        const body = sanitizeParseApiBody({
            ok: true,
            layoutMeta: {
                sheetName: 'TDSheet',
                row_outline_levels: new Array(31215).fill(1),
                column_catalog: { metrics: Array.from({ length: 100 }, (_, i) => ({ i })) },
                ontology: { row_pattern: 'bu_kol_pairs', parser_rule: { scenarioId: 'uk_card' } },
            },
            parsePreview: { headers: ['period'], rows: [{ period: '1' }], rowCount: 31215 },
            reasoningTrace: {
                router: { scenarioId: 'uk_card', confidence: 0.9, ontology: { nested: { a: 1 } } },
                ontology: { row_pattern: 'bu_kol_pairs', classifier_ranked: [{ structure_id: 'uk_journal_58' }] },
            },
        });
        assert.doesNotThrow(() => JSON.stringify(body));
        assert.ok(JSON.stringify(body).length < 50_000);
        assert.equal(body.reasoningTrace.router.scenarioId, 'uk_card');
        assert.equal(body.reasoningTrace.ontology.classifier_ranked, undefined);
    });

    it('compactRuleForClient keeps meta without huge extras', () => {
        const rule = compactRuleForClient({
            meta: { name: 'UK' },
            layout: { layout_type: 'fixed_columns' },
            columns: Array.from({ length: 5 }, (_, i) => ({ target: `c${i}` })),
            huge: { rows: new Array(1000).fill(1) },
        });
        assert.equal(rule.meta.name, 'UK');
        assert.equal(rule.huge, undefined);
    });
});

describe('shouldUseStructureOrchestrator', () => {
    it('uk_card scenarioId does not block structure path', () => {
        assert.equal(
            shouldUseStructureOrchestrator({
                fileName: 'карт 58.1_HP.xlsx',
                scenarioId: 'uk_card',
                orchestratorAnswers: { scenarioId: 'uk_card' },
            }),
            true
        );
    });

    it('opif still skips structure path', () => {
        assert.equal(
            shouldUseStructureOrchestrator({
                fileName: 'broker.xlsx',
                scenarioId: 'opif_broker',
                orchestratorAnswers: {},
            }),
            false
        );
    });
});
