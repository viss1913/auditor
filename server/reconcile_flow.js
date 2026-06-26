const { buildReconcileCatalog } = require('./reconcile_catalog');
const { planReconciliationWithLlm } = require('./reconcile_plan_llm');
const { resolvePlanSources, parseSourceRef } = require('./reconcile_sources');
const { runReconciliation } = require('./reconcile_engine');
const { importReportSnapshot, enrichAuditSnapshotInPlace } = require('./reconcile_report_import');
const { formatReconcileAssistantMessage } = require('./reconcile_api');
const {
    buildReconcileClarification,
    looksLikeReconcileIntent,
    isOpifLegacyAudit,
} = require('./reconcile_intent');
const { shouldUseLlmReply } = require('./martin_flags');
const {
    buildSecurityCrosswalk,
    enrichTableWithSecurity,
} = require('./security_resolver');
const { sourceRole } = require('./audit_scenarios');
const {
    runOpifUkBrokerLegacyAudit,
    runOpifUkDepoLegacyAudit,
    runOpifThreeWayLegacyAudit,
    enrichDepoOnAuditRows,
} = require('./opif_legacy_audit');

function formatEnrichDepoAssistantMessage(imported) {
    const s = imported.summary || {};
    return (
        `**Дополнила отчёт аудита колонками ДЕПО** (та же вкладка).\n\n` +
        `✅ Найдено в ДЕПО: **${s.depoMatched ?? 0}** из **${s.leftCount ?? imported.rowCount ?? '?'}** строк.\n\n` +
        `Смотри **depoFound**, **audit_depo**, **ukGroupQty** / **depoGroupQty**.`
    );
}

async function executeReconcileFromMessage({
    message,
    snapshotStore,
    chatSessionStore,
    auditorSlug = 'martin',
    projectId = null,
    chatSessionId = null,
    activeSnapshotId = null,
    useLlm = null,
}) {
    if (!looksLikeReconcileIntent(message)) {
        return { ok: false, error: 'Не похоже на команду сверки' };
    }
    if (!chatSessionId && !projectId) {
        return {
            ok: false,
            assistantMessage: 'Открой чат сессии с таблицами или укажи проект — без этого сверку не запущу.',
        };
    }

    const catalog = await buildReconcileCatalog({
        store: snapshotStore,
        chatSessionStore,
        auditorSlug,
        projectId,
        chatSessionId,
        activeSnapshotId,
    });

    const clarification = buildReconcileClarification(message, catalog);
    if (clarification) {
        return {
            ok: false,
            needsClarification: true,
            assistantMessage: clarification.assistantMessage,
            questions: clarification.questions || [],
            catalog,
        };
    }

    const plan = await planReconciliationWithLlm({
        message,
        catalog,
        useLlm: useLlm != null ? useLlm : isOpifLegacyAudit(message) ? false : shouldUseLlmReply(),
    });

    if (!plan) {
        return {
            ok: false,
            assistantMessage:
                'Не смогла построить план сверки. Напиши явно: **сверь [таблица A] с [таблица B] по period, name; сравни quantity, amount**.',
            catalog,
        };
    }

    const ephemeralCache = new Map();
    let { left, right, broker, depo } = await resolvePlanSources(snapshotStore, plan, {
        auditorSlug,
        projectId,
        ephemeralCache,
    });

    const matcher = plan.matcher || plan.auditScenarioId;

    if (matcher !== 'opif_enrich_depo' && plan.securityMatch) {
        const crosswalk = buildSecurityCrosswalk([left.rows, right.rows]);
        const leftSide = sourceRole(catalog.sources?.find((s) => s.ref === plan.left?.ref));
        const rightSide = sourceRole(catalog.sources?.find((s) => s.ref === plan.right?.ref));
        left = enrichTableWithSecurity(left, { side: leftSide, crosswalk });
        right = enrichTableWithSecurity(right, { side: rightSide, crosswalk });
    }

    let reconcileResult;
    let imported;

    if (matcher === 'opif_enrich_depo' || plan.outputMode === 'enrich_active') {
        const depoTable = right;
        reconcileResult = enrichDepoOnAuditRows(
            { headers: left.headers, rows: left.rows },
            { headers: depoTable.headers, rows: depoTable.rows }
        );
        const activeParsed = parseSourceRef(plan.left?.ref);
        const snapshotId = activeParsed?.id ? parseInt(activeParsed.id, 10) : activeSnapshotId;
        imported = await enrichAuditSnapshotInPlace(snapshotStore, {
            snapshotId,
            reconcileResult,
            plan,
            depoLabel: plan.right?.label || depoTable.label,
        });
        return {
            ok: true,
            assistantMessage: formatEnrichDepoAssistantMessage(imported),
            reconcileOperation: true,
            snapshotId: imported.snapshotId,
            headers: imported.headers,
            tableMeta: imported.tableMeta,
            summary: imported.summary,
            plan,
            catalog,
            enrichedInPlace: true,
        };
    }

    if (matcher === 'opif_legacy_three' || plan.auditScenarioId === 'opif_three_way') {
        const brokerTable = broker || right;
        const depoTable = depo || right;
        reconcileResult = runOpifThreeWayLegacyAudit(
            { headers: left.headers, rows: left.rows },
            { headers: brokerTable.headers, rows: brokerTable.rows },
            { headers: depoTable.headers, rows: depoTable.rows }
        );
    } else if (matcher === 'opif_legacy_depo' || plan.auditScenarioId === 'opif_uk_depo') {
        reconcileResult = runOpifUkDepoLegacyAudit(
            { headers: left.headers, rows: left.rows },
            { headers: right.headers, rows: right.rows }
        );
    } else if (
        matcher === 'opif_legacy_broker' ||
        matcher === 'opif_legacy' ||
        plan.auditScenarioId === 'opif_uk_broker'
    ) {
        reconcileResult = runOpifUkBrokerLegacyAudit(
            { headers: left.headers, rows: left.rows },
            { headers: right.headers, rows: right.rows }
        );
    } else {
        reconcileResult = runReconciliation(
            { headers: left.headers, rows: left.rows },
            { headers: right.headers, rows: right.rows },
            plan
        );
    }

    imported = await importReportSnapshot(snapshotStore, {
        projectId,
        plan,
        leftLabel: plan.left?.label || left.label,
        rightLabel: plan.right?.label || right.label,
        reconcileResult,
        title: plan.reportLabel ? `${plan.reportLabel}: ${plan.left?.label} ↔ ${plan.right?.label}` : undefined,
    });

    return {
        ok: true,
        assistantMessage: formatReconcileAssistantMessage(imported),
        reconcileOperation: true,
        snapshotId: imported.snapshotId,
        headers: imported.headers,
        tableMeta: imported.tableMeta,
        summary: imported.summary,
        plan,
        catalog,
    };
}

module.exports = {
    executeReconcileFromMessage,
};
