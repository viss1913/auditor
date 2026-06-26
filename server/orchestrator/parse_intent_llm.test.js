const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLlmParseIntent } = require('./parse_intent_llm');

describe('parse_intent_llm', () => {
    it('sanitizeLlmParseIntent: брокер 1.1', () => {
        const out = sanitizeLlmParseIntent(
            {
                scenarioId: 'opif_broker',
                filePrefix: '1F018',
                brokerSection: '1.1',
                mergeOneTable: true,
                confidence: 0.91,
                reason: 'прекращённые сделки',
            },
            'спарси 1F018 прекращённые'
        );
        assert.equal(out.scenarioId, 'opif_broker');
        assert.equal(out.filePrefix, '1F018_');
        assert.equal(out.brokerSection, '1.1');
        assert.equal(out.mergeOneTable, true);
    });

    it('sanitizeLlmParseIntent: отбрасывает мусор', () => {
        const out = sanitizeLlmParseIntent(
            { scenarioId: 'hack', brokerSection: '9.9', confidence: 2 },
            'test'
        );
        assert.equal(out.scenarioId, null);
        assert.equal(out.brokerSection, null);
        assert.equal(out.confidence, 1);
    });
});
