const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { detectAuditScenario, applyAuditScenarioPlan, sourceRole, AUDIT_SCENARIOS } = require('./audit_scenarios');

describe('audit_scenarios', () => {
    const catalog = { activeSnapshotId: 500 };
    const uk = {
        ref: 'snapshot:500',
        label: 'карт 58.1 фильтр',
        scenarioId: 'uk_card',
        headers: ['period', 'name', 'quantity', 'amount', 'credit_account'],
    };
    const broker = {
        ref: 'snapshot:396',
        label: 'opif_broker',
        scenarioId: 'opif_broker',
        headers: ['registrationDate', 'name', 'quantity', 'amount', 'regNum', 'isin'],
    };

    it('detectAuditScenario: opif_uk_broker', () => {
        const hit = detectAuditScenario(
            'Надо сделать Аудит. результат в новую таблицу. сверяем с брокером',
            catalog,
            uk,
            broker
        );
        assert.ok(hit);
        assert.equal(hit.scenario.id, 'opif_uk_broker');
        assert.ok(hit.score >= 4);
    });

    it('applyAuditScenarioPlan: securityMatch + enrich_left', () => {
        const plan = applyAuditScenarioPlan(
            { left: { ref: uk.ref }, right: { ref: broker.ref } },
            { id: 'opif_uk_broker', name: 'test', plan: AUDIT_SCENARIOS.opif_uk_broker.plan },
            uk.headers,
            broker.headers
        );
        assert.equal(plan.join, 'enrich_left');
        assert.equal(plan.securityMatch, false);
        assert.equal(plan.matcher, 'opif_legacy_broker');
        assert.equal(plan.auditScenarioId, 'opif_uk_broker');
        assert.ok(plan.leftKeys.includes('period'));
    });

    it('sourceRole', () => {
        assert.equal(sourceRole(broker), 'broker');
        assert.equal(sourceRole(uk), 'uk');
    });

    const depo = {
        ref: 'snapshot:400',
        label: 'opif_depo',
        scenarioId: 'opif_depo',
        headers: ['registrationDate', 'name', 'quantity', 'operationType'],
    };

    it('detectAuditScenario: opif_uk_depo', () => {
        const hit = detectAuditScenario('Сверь УК с депозитарием', catalog, uk, depo);
        assert.ok(hit);
        assert.equal(hit.scenario.id, 'opif_uk_depo');
    });

    it('detectAuditScenario: opif_three_way', () => {
        const hit = detectAuditScenario(
            'Полный аудит с брокером и депо',
            catalog,
            uk,
            null,
            broker,
            depo
        );
        assert.ok(hit);
        assert.equal(hit.scenario.id, 'opif_three_way');
    });

    it('detectAuditScenario: opif_enrich_depo', () => {
        const auditReport = {
            ref: 'snapshot:500',
            label: 'Аудит: карт ↔ брокер',
            scenarioId: 'reconcile_report',
            reconcileReport: true,
            headers: ['period', 'name', 'brokerFound', 'audit_result'],
        };
        const cat = { activeSnapshotId: 500, sources: [auditReport, depo] };
        const hit = detectAuditScenario(
            'Добавь сверку с депо в текущую таблицу аудита',
            cat,
            auditReport,
            depo
        );
        assert.ok(hit);
        assert.equal(hit.scenario.id, 'opif_enrich_depo');
    });
});
