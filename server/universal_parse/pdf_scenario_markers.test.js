const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildAutoMarkersFromText,
    ensureMinMarkers,
} = require('../universal_parse/pdf_scenario_markers');

describe('pdf_scenario_markers', () => {
    it('buildAutoMarkersFromText: logistics keywords', () => {
        const text = 'Маршрут Отправитель Получатель Склад логистика';
        const m = buildAutoMarkersFromText(text);
        assert.ok(m.includes('маршрут'));
        assert.ok(m.includes('отправитель'));
        assert.ok(m.length >= 2);
    });

    it('ensureMinMarkers: fills from text when empty', () => {
        const m = ensureMinMarkers([], 'брокерский отчёт ISIN северный мост', {});
        assert.ok(m.length >= 2);
    });
});
