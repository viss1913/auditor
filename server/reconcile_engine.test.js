const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runReconciliation, normalizeSecurityName } = require('./reconcile_engine');
const { enrichRowWithSecurity } = require('./security_resolver');

describe('reconcile_engine', () => {
    const left = {
        headers: ['period', 'regNum', 'quantity', 'amount'],
        rows: [
            { period: '01.01.2025', regNum: 'A1', quantity: 10, amount: 100 },
            { period: '02.01.2025', regNum: 'A2', quantity: 5, amount: 50 },
        ],
    };
    const right = {
        headers: ['period', 'regNum', 'quantity', 'amount'],
        rows: [
            { period: '01.01.2025', regNum: 'A1', quantity: 10, amount: 100 },
            { period: '02.01.2025', regNum: 'A2', quantity: 4, amount: 50 },
            { period: '03.01.2025', regNum: 'A3', quantity: 1, amount: 10 },
        ],
    };

    it('match и расхождения', () => {
        const out = runReconciliation(left, right, {
            leftKeys: ['period', 'regNum'],
            rightKeys: ['period', 'regNum'],
            valuePairs: [
                { left: 'quantity', right: 'quantity', tolerance: 0.01 },
                { left: 'amount', right: 'amount', tolerance: 0.01 },
            ],
        });
        assert.equal(out.summary.matched, 1);
        assert.equal(out.summary.value_mismatch, 1);
        assert.equal(out.summary.only_right, 1);
        assert.ok(out.rows.some((r) => r.reconcile_status === 'value_mismatch'));
        assert.ok(out.rows.some((r) => r.reconcile_status === 'only_right'));
    });

    it('разные имена ключей', () => {
        const rightAlt = {
            headers: ['Дата', 'ISIN', 'Количество'],
            rows: [{ Дата: '01.01.2025', ISIN: 'A1', Количество: 10 }],
        };
        const out = runReconciliation(
            { headers: left.headers, rows: [left.rows[0]] },
            rightAlt,
            {
                leftKeys: ['period', 'regNum'],
                rightKeys: ['Дата', 'ISIN'],
                valuePairs: [{ left: 'quantity', right: 'Количество', tolerance: 0.01 }],
            }
        );
        assert.equal(out.summary.matched, 1);
    });

    it('нормализация дат dd.mm.yyyy', () => {
        const left = {
            headers: ['period', 'name', 'quantity'],
            rows: [{ period: '30.12.2024', name: 'ВТБ', quantity: 10 }],
        };
        const right = {
            headers: ['registrationDate', 'name', 'quantity'],
            rows: [{ registrationDate: '2024-12-30', name: 'ВТБ', quantity: 10 }],
        };
        const out = runReconciliation(left, right, {
            leftKeys: ['period', 'name'],
            rightKeys: ['registrationDate', 'name'],
            valuePairs: [{ left: 'quantity', right: 'quantity', tolerance: 0.01 }],
        });
        assert.equal(out.summary.matched, 1);
    });

    it('нормализация имён УК ↔ брокер', () => {
        assert.equal(normalizeSecurityName('мечел, ап'), 'мечел');
        assert.equal(normalizeSecurityName('ПАО "Мечел" АП'), 'мечел');
        const left = {
            headers: ['period', 'name', 'quantity', 'amount'],
            rows: [{ period: '30.12.2024', name: 'Мечел, ап', quantity: 10, amount: 1083.5 }],
        };
        const right = {
            headers: ['registrationDate', 'name', 'quantity', 'amount'],
            rows: [{ registrationDate: '30.12.2024', name: 'ПАО "Мечел" АП', quantity: 10, amount: 1083.5 }],
        };
        const out = runReconciliation(left, right, {
            leftKeys: ['period', 'name'],
            rightKeys: ['registrationDate', 'name'],
            valuePairs: [
                { left: 'quantity', right: 'quantity', tolerance: 0.01 },
                { left: 'amount', right: 'amount', tolerance: 0.01 },
            ],
        });
        assert.equal(out.summary.matched, 1);
    });

    it('enrich_left: исходные колонки + broker_*', () => {
        const left = {
            headers: ['period', 'name', 'quantity', 'credit_account'],
            rows: [
                { period: '30.12.2024', name: 'Мечел, ап', quantity: 10, credit_account: '76.07.2' },
                { period: '01.01.2025', name: 'ВТБ', quantity: 5, credit_account: '76.07.2' },
            ],
        };
        const right = {
            headers: ['registrationDate', 'name', 'quantity'],
            rows: [{ registrationDate: '30.12.2024', name: 'ПАО "Мечел" АП', quantity: 10 }],
        };
        const out = runReconciliation(left, right, {
            join: 'enrich_left',
            leftKeys: ['period', 'name'],
            rightKeys: ['registrationDate', 'name'],
            valuePairs: [{ left: 'quantity', right: 'quantity', tolerance: 0.01 }],
        });
        assert.equal(out.summary.matched, 1);
        assert.equal(out.summary.only_left, 1);
        assert.ok(out.headers.includes('credit_account'));
        assert.ok(out.headers.includes('broker_quantity'));
        assert.equal(out.rows[0].credit_account, '76.07.2');
        assert.equal(out.rows[0].reconcile_status, 'match');
        assert.equal(out.rows[0].broker_quantity, 10);
        assert.equal(out.rows[1].reconcile_status, 'only_left');
    });

    it('securityMatch: мечел УК ↔ брокер по security keys', () => {
        const crosswalk = require('./security_resolver').buildSecurityCrosswalk([
            [{ name: 'Мечел, ап', regNum: 'ап', period: '30.12.2024', quantity: 10, amount: 1083.5 }],
            [
                {
                    name: 'ПАО "Мечел" АП',
                    regNum: '2-01-55005-E',
                    isin: 'RU0009084396',
                    registrationDate: '30.12.2024',
                    quantity: 10,
                    amount: 1083.5,
                },
            ],
        ]);
        const leftRow = enrichRowWithSecurity(
            { period: '30.12.2024', name: 'Мечел, ап', regNum: 'ап', quantity: 10, amount: 1083.5 },
            { side: 'uk', crosswalk }
        );
        const rightRow = enrichRowWithSecurity(
            {
                registrationDate: '30.12.2024',
                name: 'ПАО "Мечел" АП',
                regNum: '2-01-55005-E',
                isin: 'RU0009084396',
                quantity: 10,
                amount: 1083.5,
            },
            { side: 'broker', crosswalk }
        );
        const out = runReconciliation(
            { headers: ['period', 'name', 'quantity', 'amount', '_security_key'], rows: [leftRow] },
            { headers: ['registrationDate', 'name', 'quantity', 'amount', '_security_key'], rows: [rightRow] },
            {
                join: 'enrich_left',
                securityMatch: true,
                leftDateKey: 'period',
                rightDateKey: 'registrationDate',
                leftKeys: ['period', '_security_key'],
                rightKeys: ['registrationDate', '_security_key'],
                valuePairs: [
                    { left: 'quantity', right: 'quantity', tolerance: 0.01 },
                    { left: 'amount', right: 'amount', tolerance: 0.01 },
                ],
                auditScenarioId: 'opif_uk_broker',
            }
        );
        assert.equal(out.summary.matched, 1);
        assert.equal(out.rows[0].audit_result, 'Найдено');
        assert.ok(out.headers[0] === 'audit_result');
        assert.ok(out.rows[0].broker_quantity === 10 || out.rows[0].broker_quantity === '10');
    });

    it('regNum: 10401000B = 1-04-01000-B', () => {
        const left = {
            headers: ['period', 'name', 'regNum', 'quantity'],
            rows: [{ period: '14.02.2025', name: 'ВТБ', regNum: '10401000B', quantity: 10 }],
        };
        const right = {
            headers: ['registrationDate', 'name', 'regNum', 'quantity'],
            rows: [{ registrationDate: '14.02.2025', name: 'ВТБ', regNum: '1-04-01000-B', quantity: 10 }],
        };
        const out = runReconciliation(left, right, {
            leftKeys: ['period', 'name'],
            rightKeys: ['registrationDate', 'name'],
            valuePairs: [
                { left: 'regNum', right: 'regNum', tolerance: 0.01 },
                { left: 'quantity', right: 'quantity', tolerance: 0.01 },
            ],
        });
        assert.equal(out.summary.matched, 1);
        assert.equal(out.summary.value_mismatch, 0);
    });

    it('regNum: короткий ап у УК не даёт ложного расхождения', () => {
        const left = {
            headers: ['period', 'name', 'regNum', 'quantity'],
            rows: [{ period: '14.02.2025', name: 'ВТБ, ао', regNum: 'ао', quantity: 10 }],
        };
        const right = {
            headers: ['registrationDate', 'name', 'regNum', 'quantity'],
            rows: [{ registrationDate: '14.02.2025', name: 'ВТБ', regNum: '1-04-01000-B', quantity: 10 }],
        };
        const out = runReconciliation(left, right, {
            leftKeys: ['period', 'name'],
            rightKeys: ['registrationDate', 'name'],
            valuePairs: [{ left: 'regNum', right: 'regNum', tolerance: 0.01 }],
        });
        assert.equal(out.summary.value_mismatch, 0);
    });
});
