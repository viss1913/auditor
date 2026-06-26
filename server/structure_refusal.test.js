const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildStructureRefusalMessage } = require('./structure_refusal');

describe('structure_refusal', () => {
    it('buildStructureRefusalMessage: audit-safe текст', () => {
        const msg = buildStructureRefusalMessage({
            sheetName: 'Лист1',
            structure: {
                structure_id: 'unknown',
                fingerprint_reason: 'no_structure_match',
                alternatives: [],
            },
            reason: 'unknown_structure',
        });
        assert.match(msg, /аудите гадать нельзя/i);
        assert.match(msg, /Лист1/);
        assert.match(msg, /no_structure_match/);
    });
});
