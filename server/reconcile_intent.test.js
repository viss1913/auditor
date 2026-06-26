const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    looksLikeReconcileIntent,
    isAuditResultTableIntent,
    parseReconcileIntent,
    parseKeysAndPairsFromMessage,
} = require('./reconcile_intent');

describe('reconcile_intent', () => {
    it('looksLikeReconcileIntent: аудит и сверяем', () => {
        assert.equal(looksLikeReconcileIntent('Надо сделать Аудит. сверяем с брокером'), true);
        assert.equal(looksLikeReconcileIntent('сверь текущую таблицу с брокером'), true);
        assert.equal(looksLikeReconcileIntent('сделай фильтр credit_account=76'), false);
    });

    it('isAuditResultTableIntent не путает с split', () => {
        const msg =
            'Надо сделать Аудит. результат в новую таблицу с пометкой нашли не нашли';
        assert.equal(isAuditResultTableIntent(msg), true);
        assert.equal(looksLikeReconcileIntent(msg), true);
    });

    it('parseKeysAndPairsFromMessage: period ↔ registrationDate', () => {
        const parsed = parseKeysAndPairsFromMessage(
            'сверь с брокером по period и registrationDate, name; сравни regNum, quantity, amount',
            ['period', 'name', 'regNum', 'quantity', 'amount'],
            ['registrationDate', 'name', 'regNum', 'quantity', 'amount']
        );
        assert.deepEqual(parsed.leftKeys, ['period', 'name']);
        assert.deepEqual(parsed.rightKeys, ['registrationDate', 'name']);
        assert.ok(parsed.valuePairs.some((p) => p.left === 'quantity'));
    });

    it('parseReconcileIntent: UK + broker из каталога', () => {
        const catalog = {
            activeSnapshotId: 397,
            sources: [
                {
                    ref: 'snapshot:397',
                    label: 'карт 58.1_HP',
                    headers: ['period', 'name', 'regNum', 'quantity', 'amount'],
                    rowCount: 100,
                },
                {
                    ref: 'snapshot:396',
                    label: 'opif_broker',
                    scenarioId: 'opif_broker',
                    headers: ['registrationDate', 'name', 'regNum', 'quantity', 'amount'],
                    rowCount: 200,
                },
            ],
        };
        const plan = parseReconcileIntent(
            'сверь текущую таблицу с брокером по period и registrationDate, name; сравни quantity, amount',
            catalog
        );
        assert.ok(plan);
        assert.equal(plan.left.ref, 'snapshot:397');
        assert.equal(plan.right.ref, 'snapshot:396');
        assert.ok(plan.leftKeys.includes('period'));
        assert.ok(plan.rightKeys.includes('registrationDate'));
        assert.equal(plan.join, 'enrich_left');
        assert.equal(plan.securityMatch, false);
        assert.equal(plan.matcher, 'opif_legacy_broker');
        assert.equal(plan.auditScenarioId, 'opif_uk_broker');
    });

    it('parseReconcileIntent: аудит берёт активную таблицу, не сырой УК', () => {
        const catalog = {
            activeSnapshotId: 500,
            sources: [
                {
                    ref: 'snapshot:500',
                    label: 'карт 58.1 фильтр',
                    headers: ['period', 'name', 'quantity', 'credit_account'],
                    rowCount: 50,
                },
                {
                    ref: 'snapshot:397',
                    label: 'карт 58.1_HP',
                    headers: ['period', 'name', 'quantity', 'credit_account'],
                    rowCount: 15772,
                },
                {
                    ref: 'snapshot:396',
                    label: 'opif_broker',
                    scenarioId: 'opif_broker',
                    headers: ['registrationDate', 'name', 'quantity', 'amount'],
                    rowCount: 200,
                },
            ],
        };
        const plan = parseReconcileIntent(
            'Надо сделать Аудит. результат в новую таблицу. сверяем с брокером по registrationDate, name',
            catalog
        );
        assert.ok(plan);
        assert.equal(plan.left.ref, 'snapshot:500');
        assert.equal(plan.join, 'enrich_left');
    });

    it('parseReconcileIntent: активен брокер — left всё равно УК/карт', () => {
        const catalog = {
            activeSnapshotId: 396,
            sources: [
                {
                    ref: 'snapshot:396',
                    label: 'opif_broker_4231files',
                    scenarioId: 'opif_broker',
                    headers: ['registrationDate', 'name', 'quantity', 'amount'],
                    rowCount: 18538,
                },
                {
                    ref: 'snapshot:397',
                    label: 'карт 58.1_HP · TDSheet',
                    headers: ['period', 'name', 'quantity', 'amount', 'credit_account'],
                    rowCount: 15772,
                },
                {
                    ref: 'snapshot:395',
                    label: 'opif_depo_28files',
                    scenarioId: 'opif_depo',
                    headers: ['period', 'name', 'quantity'],
                    rowCount: 176,
                },
            ],
        };
        const plan = parseReconcileIntent('Надо сделать Аудит. сверяем с брокером', catalog);
        assert.ok(plan);
        assert.equal(plan.right.ref, 'snapshot:396');
        assert.equal(plan.left.ref, 'snapshot:397');
    });

    it('parseReconcileIntent: depo only', () => {
        const catalog = {
            activeSnapshotId: 397,
            sources: [
                {
                    ref: 'snapshot:397',
                    label: 'карт 58.1',
                    headers: ['period', 'name', 'quantity', 'operationType'],
                    rowCount: 100,
                },
                {
                    ref: 'snapshot:395',
                    label: 'opif_depo',
                    scenarioId: 'opif_depo',
                    headers: ['registrationDate', 'quantity', 'operationType'],
                    rowCount: 50,
                },
            ],
        };
        const plan = parseReconcileIntent('Сверь УК с депозитарием', catalog);
        assert.ok(plan);
        assert.equal(plan.auditScenarioId, 'opif_uk_depo');
        assert.equal(plan.matcher, 'opif_legacy_depo');
    });

    it('parseReconcileIntent: enrich depo in-place', () => {
        const catalog = {
            activeSnapshotId: 501,
            sources: [
                {
                    ref: 'snapshot:501',
                    label: 'Аудит: карт ↔ брокер',
                    scenarioId: 'reconcile_report',
                    reconcileReport: true,
                    headers: ['period', 'name', 'brokerFound', 'audit_result'],
                    rowCount: 10,
                },
                {
                    ref: 'snapshot:395',
                    label: 'opif_depo',
                    scenarioId: 'opif_depo',
                    headers: ['registrationDate', 'quantity', 'operationType'],
                    rowCount: 50,
                },
            ],
        };
        const plan = parseReconcileIntent('Добавь сверку с депо в текущую таблицу аудита', catalog);
        assert.ok(plan);
        assert.equal(plan.auditScenarioId, 'opif_enrich_depo');
        assert.equal(plan.outputMode, 'enrich_active');
        assert.equal(plan.left.ref, 'snapshot:501');
    });
});
