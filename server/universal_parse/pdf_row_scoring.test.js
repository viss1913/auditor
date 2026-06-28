const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { scoreDataRow, suggestDataStartByScoring } = require('./pdf_row_scoring');

describe('pdf_row_scoring', () => {
    it('scoreDataRow: ISIN + date + qty', () => {
        const s = scoreDataRow({
            text: 'RU000A0JX0J2 15.02.2025 1 000 шт',
        });
        assert.ok(s >= 0.6);
    });

    it('scoreDataRow: пустая строка = 0', () => {
        assert.equal(scoreDataRow({ text: '' }), 0);
    });

    it('suggestDataStartByScoring: пропускает шапку', () => {
        const rows = [
            { text: 'Логистика склад отчёт' },
            { text: 'Маршрут Отправитель Получатель' },
            { text: 'MSK-SPB ООО Альфа ООО Бета' },
            { text: 'SPB-MSK ООО Гamma ООО Дельта' },
        ];
        const idx = suggestDataStartByScoring(rows);
        assert.ok(idx >= 1);
    });
});
