const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    parseUpdPdf,
    parseUpdFromLines,
    validateUpdParse,
    parseVatLine,
    parseTotals,
    parseGluedQtyLine,
} = require('./parse_upd_pdf');
const { probePdfKind } = require('./pdf_probe');

const FIXTURE = path.join(__dirname, 'fixtures', 'tricky', 'pavel', 'UPD_69_2025-01-09 [Xg9AgY].pdf');

describe('parse_upd_pdf helpers', () => {
    it('parseVatLine: 10% + суммы', () => {
        const vat = parseVatLine('10%19971,00219681,00—');
        assert.equal(vat.vat_rate, '10%');
        assert.equal(vat.vat_amount, 19971);
        assert.equal(vat.amount_gross, 219681);
    });

    it('parseVatLine: без НДС', () => {
        const vat = parseVatLine('без НДСбез НДС0,00—');
        assert.equal(vat.vat_rate, 'без НДС');
        assert.equal(vat.vat_amount, 0);
        assert.equal(vat.amount_gross, 0);
    });

    it('parseGluedQtyLine: палета qty=190 price=0', () => {
        const qty = parseGluedQtyLine('—796шт190,000,00');
        assert.equal(qty.qty, 190);
        assert.equal(qty.price, 0);
        assert.equal(qty.amount_net, 0);
    });

    it('parseTotals: итоги из строки Эдивеб', () => {
        const totals = parseTotals(['Всего к оплате (9)541217,04X54121,70595338,74']);
        assert.equal(totals.amount_net_total, 541217.04);
        assert.equal(totals.vat_total, 54121.7);
        assert.equal(totals.amount_gross_total, 595338.74);
    });
});

describe('pdf_probe UPD', () => {
    it('UPD_69 → upd_ediweb', async () => {
        const buf = fs.readFileSync(FIXTURE);
        const probe = await probePdfKind(buf);
        assert.equal(probe.kind, 'upd_ediweb');
        assert.ok(probe.confidence >= 0.8);
    });
});

describe('parse_upd_pdf UPD_69', () => {
    it('6 позиций, плоская таблица, суммы сходятся', async () => {
        const buf = fs.readFileSync(FIXTURE);
        const parsed = await parseUpdPdf(buf, 'UPD_69.pdf');
        assert.ok(parsed);
        assert.equal(parsed.rows.length, 6);
        assert.ok(validateUpdParse(parsed));

        const row1 = parsed.rows[0];
        assert.equal(row1['УПД №'], '69');
        assert.equal(row1['Покупатель'], 'ООО "АГРОАСПЕКТ"');
        assert.equal(row1['Код товара'], '36672321');
        assert.equal(row1['Кол-во'], 4200);
        assert.equal(row1['Цена'], 47.55);
        assert.equal(row1['Сумма без НДС'], 199710);
        assert.equal(row1['Сумма НДС'], 19971);
        assert.equal(row1['Сумма с НДС'], 219681);

        const row6 = parsed.rows[5];
        assert.equal(row6['Наименование'], 'Палета 1200х800');
        assert.equal(row6['Кол-во'], 190);
        assert.equal(row6['Цена'], 0);
        assert.equal(row6['Ставка НДС'], 'без НДС');

        assert.equal(parsed.totals.amount_gross_total, 595338.74);
        assert.ok(parsed.doc_header.seller_address.includes('141304'));
        assert.equal(parsed.doc_header.currency, 'Российский рубль, 643');
    });

    it('каждая строка содержит поля шапки', () => {
        const buf = fs.readFileSync(FIXTURE);
        const probe = fs.readFileSync(FIXTURE);
        return probePdfKind(probe).then((p) => {
            const parsed = parseUpdFromLines(p.lines);
            for (const row of parsed.rows) {
                assert.equal(row['УПД №'], '69');
                assert.equal(row['Статус'], 'СЧФДОП');
                assert.equal(row['ЭДО'], 'Эдивеб');
            }
        });
    });
});
