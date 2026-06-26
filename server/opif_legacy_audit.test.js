const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    findBrokerMatch,
    toLegacyRow,
    runOpifUkBrokerLegacyAudit,
    runOpifUkDepoLegacyAudit,
    runOpifThreeWayLegacyAudit,
    enrichDepoOnAuditRows,
    buildRegIsinMaps,
    buildUkDepoQtyMaps,
} = require('./opif_legacy_audit');

describe('opif_legacy_audit', () => {
    it('regNum norm: 10401000B = 1-04-01000-B', () => {
        const maps = buildRegIsinMaps([
            toLegacyRow({ regNum: '10401000B' }),
            toLegacyRow({ regNum: '1-04-01000-B', isin: 'RU000A0JP5V6' }),
        ]);
        const uk = toLegacyRow({
            registrationDate: '14.02.2025',
            operationType: 'Поступление ц/б',
            regNum: '10401000B',
            quantity: 10,
            amount: 1000,
        });
        const broker = toLegacyRow({
            registrationDate: '14.02.2025',
            operationType: 'Покупка',
            regNum: '1-04-01000-B',
            isin: 'RU000A0JP5V6',
            quantity: 10,
            amount: 1000,
        });
        assert.ok(findBrokerMatch(uk, [broker], maps));
    });

    it('buy/sell разделяет сделки в один день', () => {
        const maps = buildRegIsinMaps([]);
        const uk = toLegacyRow({
            registrationDate: '14.02.2025',
            operationType: 'Продажа',
            regNum: '10401000B',
            quantity: 5,
            amount: 500,
        });
        const buy = toLegacyRow({
            registrationDate: '14.02.2025',
            operationType: 'Покупка',
            regNum: '10401000B',
            quantity: 5,
            amount: 500,
        });
        assert.equal(findBrokerMatch(uk, [buy], maps), undefined);
    });

    it('runOpifUkBrokerLegacyAudit: enrich отчёт', () => {
        const out = runOpifUkBrokerLegacyAudit(
            {
                headers: ['period', 'name', 'regNum', 'quantity', 'amount'],
                rows: [
                    {
                        period: '14.02.2025',
                        registrationDate: '14.02.2025',
                        operationType: 'Поступление ц/б',
                        name: 'ВТБ',
                        regNum: '10401000B',
                        quantity: 10,
                        amount: 1000,
                    },
                ],
            },
            {
                headers: ['registrationDate', 'name', 'regNum', 'quantity', 'amount'],
                rows: [
                    {
                        registrationDate: '14.02.2025',
                        operationType: 'Покупка',
                        name: 'ВТБ',
                        regNum: '1-04-01000-B',
                        quantity: 10,
                        amount: 1000,
                    },
                ],
            }
        );
        assert.equal(out.summary.matched, 1);
        assert.equal(out.rows[0].brokerFound, true);
        assert.equal(out.rows[0].audit_result, 'Найдено');
    });

    it('runOpifUkDepoLegacyAudit: агрегат по группе', () => {
        const out = runOpifUkDepoLegacyAudit(
            {
                headers: ['period', 'name', 'regNum', 'quantity', 'operationType'],
                rows: [
                    {
                        period: '14.02.2025',
                        registrationDate: '14.02.2025',
                        operationType: 'Поступление ц/б',
                        name: 'ВТБ',
                        regNum: '10401000B',
                        quantity: 5,
                    },
                    {
                        period: '14.02.2025',
                        registrationDate: '14.02.2025',
                        operationType: 'Поступление ц/б',
                        name: 'ВТБ',
                        regNum: '10401000B',
                        quantity: 5,
                    },
                ],
            },
            {
                headers: ['registrationDate', 'name', 'regNum', 'quantity', 'operationType'],
                rows: [
                    {
                        registrationDate: '14.02.2025',
                        operationType: 'Зачисление ЦБ',
                        name: 'ВТБ',
                        regNum: '1-04-01000-B',
                        quantity: 10,
                    },
                ],
            }
        );
        assert.equal(out.summary.matched, 2);
        assert.equal(out.rows[0].depoFound, true);
        assert.equal(out.rows[0].ukGroupQty, 10);
        assert.equal(out.rows[0].depoGroupQty, 10);
    });

    it('runOpifThreeWayLegacyAudit: broker + depo', () => {
        const uk = {
            headers: ['period', 'name', 'regNum', 'quantity', 'amount', 'operationType'],
            rows: [
                {
                    period: '14.02.2025',
                    registrationDate: '14.02.2025',
                    operationType: 'Поступление ц/б',
                    name: 'ВТБ',
                    regNum: '10401000B',
                    quantity: 10,
                    amount: 1000,
                },
            ],
        };
        const broker = {
            headers: ['registrationDate', 'regNum', 'quantity', 'amount', 'operationType'],
            rows: [
                {
                    registrationDate: '14.02.2025',
                    operationType: 'Покупка',
                    regNum: '1-04-01000-B',
                    quantity: 10,
                    amount: 1000,
                },
            ],
        };
        const depo = {
            headers: ['registrationDate', 'regNum', 'quantity', 'operationType'],
            rows: [
                {
                    registrationDate: '14.02.2025',
                    operationType: 'Зачисление ЦБ',
                    regNum: '1-04-01000-B',
                    quantity: 10,
                },
            ],
        };
        const out = runOpifThreeWayLegacyAudit(uk, broker, depo);
        assert.equal(out.rows[0].brokerFound, true);
        assert.equal(out.rows[0].depoFound, true);
        assert.equal(out.rows[0].reconcile_status, 'match');
    });

    it('enrichDepoOnAuditRows: сохраняет brokerFound', () => {
        const audit = {
            headers: ['period', 'name', 'regNum', 'quantity', 'brokerFound', 'audit_result'],
            rows: [
                {
                    period: '14.02.2025',
                    registrationDate: '14.02.2025',
                    operationType: 'Поступление ц/б',
                    name: 'ВТБ',
                    regNum: '10401000B',
                    quantity: 10,
                    brokerFound: true,
                    audit_result: 'Найдено',
                },
            ],
        };
        const depo = {
            headers: ['registrationDate', 'regNum', 'quantity', 'operationType'],
            rows: [
                {
                    registrationDate: '14.02.2025',
                    operationType: 'Зачисление ЦБ',
                    regNum: '1-04-01000-B',
                    quantity: 10,
                },
            ],
        };
        const out = enrichDepoOnAuditRows(audit, depo);
        assert.equal(out.rows[0].brokerFound, true);
        assert.equal(out.rows[0].audit_result, 'Найдено');
        assert.equal(out.rows[0].depoFound, true);
        assert.equal(out.rows[0].reconcile_status, 'match');
        assert.ok(out.headers.includes('depoFound'));
    });

    it('runOpifUkDepoLegacyAudit: УК с коротким regNum + имя матчится с ДЕПО по name', () => {
        const out = runOpifUkDepoLegacyAudit(
            {
                headers: ['period', 'name', 'regNum', 'quantity', 'operationType'],
                rows: [
                    {
                        period: '14.02.2025',
                        operationType: 'Поступление ц/б',
                        name: 'мечел, ап',
                        regNum: 'ап',
                        quantity: 10,
                    },
                ],
            },
            {
                headers: ['registrationDate', 'name', 'regNum', 'quantity', 'operationType'],
                rows: [
                    {
                        registrationDate: '14.02.2025',
                        operationType: 'Зачисление ЦБ',
                        name: 'ПАО "Мечел" ап',
                        regNum: '1-04-01000-B',
                        quantity: 10,
                    },
                ],
            }
        );
        assert.equal(out.rows[0].depoFound, true);
    });
});
