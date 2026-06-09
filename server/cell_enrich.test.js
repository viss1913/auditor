const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    extractDate,
    extractAddress,
    extractInventoryNumber,
    applyExtractFields,
    stripExtractedFromText,
    defaultExtractFields,
    sanitizeClassification,
    classifyBatchUnique,
} = require('./cell_enrich');

describe('cell_enrich extract', () => {
    it('extractDate: вытаскивает dd.mm.yyyy', () => {
        const t =
            'ППА Участок склад-ния, по адресу г.Оренбург, ул.Ленина,12, 80-000460, 31.12.2021';
        assert.equal(extractDate(t), '31.12.2021');
    });

    it('extractAddress: вытаскивает адрес после "по адресу"', () => {
        const t =
            'ППА Участок склад-ния,мостовой кран, по адресу г.Оренбург ,ул.Ленина ,12 (пл - 5000,00 кв.м.), 80-000460, 31.12.2021';
        const addr = extractAddress(t);
        assert.ok(addr);
        assert.ok(/оренбург/i.test(addr));
        assert.ok(/ленин/i.test(addr));
    });

    it('extractAddress: неструктурный текст -> null', () => {
        assert.equal(extractAddress('просто описание без адреса и реквизитов'), null);
    });

    it('extractInventoryNumber: вагон-дом пример', () => {
        const t = 'Вагон-дом на раме "Торос" 11,5 м., 000002222, 29.06.2020';
        assert.equal(extractInventoryNumber(t), '000002222');
        assert.equal(extractDate(t), '29.06.2020');
        const vals = applyExtractFields(t, defaultExtractFields());
        assert.equal(vals.inventory_extracted, '000002222');
        assert.equal(vals.date_extracted, '29.06.2020');
    });

    it('extractInventoryNumber: 80-560482 полностью', () => {
        const t = 'ППА аренда машиномест, 80-560482, 31.12.2021';
        assert.equal(extractInventoryNumber(t), '80-560482');
        const vals = applyExtractFields(t, defaultExtractFields());
        assert.equal(vals.inventory_extracted, '80-560482');
    });

    it('stripExtractedFromText: убирает номер и дату из ОС', () => {
        const t = 'ППА аренда машиномест, 80-560482, 31.12.2021';
        const cleaned = stripExtractedFromText(t);
        assert.ok(!/80-560482/.test(cleaned));
        assert.ok(!/31\.12\.2021/.test(cleaned));
        assert.ok(/машиномест/i.test(cleaned));
    });

    it('multiline: 80-560482 и очистка', () => {
        const t = 'ППА аренда\nмашиномест,\n80-560482,\n31.12.2021';
        assert.equal(extractInventoryNumber(t), '80-560482');
        const vals = applyExtractFields(t, defaultExtractFields());
        assert.equal(vals.inventory_extracted, '80-560482');
        const cleaned = stripExtractedFromText(t);
        assert.ok(!/80-560482/.test(cleaned));
        assert.ok(!/31\.12\.2021/.test(cleaned));
    });
});

describe('cell_enrich classify', () => {
    it('sanitizeClassification: low confidence => not_sure', () => {
        const out = sanitizeClassification(
            { class: 'real_estate', confidence: 0.4, reason: 'похоже на объект' },
            0.7
        );
        assert.equal(out.class, 'not_sure');
    });

    it('classifyBatchUnique: дедупликация одинаковых значений', async () => {
        let calls = 0;
        const values = ['A', 'A', 'B', ''];
        const batch = await classifyBatchUnique(values, {
            threshold: 0.7,
            classifier: async (v) => {
                calls++;
                if (v === 'A') return { class: 'movable', confidence: 0.9, reason: 'ok' };
                if (v === 'B') return { class: 'other', confidence: 0.8, reason: 'ok' };
                return { class: 'not_sure', confidence: 0, reason: 'empty' };
            },
        });
        assert.equal(calls, 2); // only A and B
        const out = batch.results;
        assert.equal(out.length, 4);
        assert.equal(out[0].class, 'movable');
        assert.equal(out[1].class, 'movable');
        assert.equal(out[2].class, 'other');
        assert.equal(out[3].class, 'not_sure');
    });
});

