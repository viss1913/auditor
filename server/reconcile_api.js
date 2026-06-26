const { auditorSlugFromRequest, resolveAuditor } = require('./auditor_context');
const {
    assertProjectAccess,
    assertSnapshotAccess,
    sendAccessError,
    HttpError,
} = require('./project_access');
const { buildReconcileCatalog } = require('./reconcile_catalog');
const { planReconciliationWithLlm } = require('./reconcile_plan_llm');
const { resolvePlanSources } = require('./reconcile_sources');
const { runReconciliation } = require('./reconcile_engine');
const { importReportSnapshot } = require('./reconcile_report_import');
const { exportSnapshotBuffer } = require('./snapshot_export');
const { shouldUseLlmReply } = require('./martin_flags');
const { listAuditScenarios } = require('./audit_scenarios');

function registerReconcileRoutes(router, { pool, snapshotStore, chatSessionStore, maybeLinkSnapshotToChat }) {
    router.get('/reconcile/scenarios', async (req, res) => {
        try {
            res.json({ ok: true, scenarios: listAuditScenarios() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/projects/:projectId/reconcile/sources', async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            await assertProjectAccess(pool, req, projectId);
            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            const chatSessionId = parseInt(req.query.chatSessionId, 10) || null;
            const activeSnapshotId = parseInt(req.query.activeSnapshotId, 10) || null;
            const catalog = await buildReconcileCatalog({
                store: snapshotStore,
                chatSessionStore,
                auditorSlug: auditor?.slug || 'martin',
                projectId,
                chatSessionId,
                activeSnapshotId,
            });
            res.json({ ok: true, ...catalog });
        } catch (err) {
            if (err instanceof HttpError) return sendAccessError(res, err);
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/reconcile/plan', async (req, res) => {
        try {
            const projectId = parseInt(req.body.projectId || req.body.project_id, 10);
            const message = String(req.body.message || '').trim();
            if (!message) return res.status(400).json({ error: 'Нужен message' });
            if (projectId) await assertProjectAccess(pool, req, projectId);

            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            const catalog = await buildReconcileCatalog({
                store: snapshotStore,
                chatSessionStore,
                auditorSlug: auditor?.slug || 'martin',
                projectId,
                chatSessionId: parseInt(req.body.chatSessionId, 10) || null,
                activeSnapshotId: parseInt(req.body.activeSnapshotId, 10) || null,
            });

            const plan = await planReconciliationWithLlm({
                message,
                catalog,
                useLlm: req.body.useLlm !== false && shouldUseLlmReply(),
            });
            if (!plan) {
                return res.status(422).json({
                    ok: false,
                    error: 'Не смогла составить план сверки. Укажи две таблицы и ключи.',
                    catalog,
                });
            }
            res.json({ ok: true, plan, catalog });
        } catch (err) {
            if (err instanceof HttpError) return sendAccessError(res, err);
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/reconcile/run', async (req, res) => {
        try {
            const projectId = parseInt(req.body.projectId || req.body.project_id, 10) || null;
            const plan = req.body.plan;
            if (!plan?.left?.ref || !plan?.right?.ref) {
                return res.status(400).json({ error: 'Нужен plan.left.ref и plan.right.ref' });
            }
            if (projectId) await assertProjectAccess(pool, req, projectId);

            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            const ephemeralCache = new Map();
            const { left, right } = await resolvePlanSources(snapshotStore, plan, {
                auditorSlug: auditor?.slug || 'martin',
                projectId,
                ephemeralCache,
            });

            const reconcileResult = runReconciliation(
                { headers: left.headers, rows: left.rows },
                { headers: right.headers, rows: right.rows },
                plan
            );

            const imported = await importReportSnapshot(snapshotStore, {
                projectId,
                plan,
                leftLabel: plan.left?.label || left.label,
                rightLabel: plan.right?.label || right.label,
                reconcileResult,
            });

            const chatSessionId = parseInt(req.body.chatSessionId, 10) || null;
            if (chatSessionId && imported.snapshotId && maybeLinkSnapshotToChat) {
                await maybeLinkSnapshotToChat({
                    chatSessionId,
                    snapshotId: imported.snapshotId,
                    label: imported.title,
                    projectId,
                });
            }

            res.json({
                ok: true,
                snapshotId: imported.snapshotId,
                headers: imported.headers,
                tableMeta: imported.tableMeta,
                summary: imported.summary,
                title: imported.title,
                assistantMessage: formatReconcileAssistantMessage(imported),
            });
        } catch (err) {
            if (err instanceof HttpError) return sendAccessError(res, err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/parse/snapshots/:id/export', async (req, res) => {
        try {
            const snapshotId = parseInt(req.params.id, 10);
            await assertSnapshotAccess(pool, req, snapshotId);
            const format = String(req.query.format || 'csv').toLowerCase();
            const exported = await exportSnapshotBuffer(snapshotStore, snapshotId, format);
            if (!exported) return res.status(404).json({ error: 'Снимок не найден' });
            res.setHeader('Content-Type', exported.contentType);
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`);
            res.send(exported.buffer);
        } catch (err) {
            if (err instanceof HttpError) return sendAccessError(res, err);
            res.status(500).json({ error: err.message });
        }
    });
}

function formatReconcileAssistantMessage(imported) {
    const { formatAuditAssistantSummary } = require('./audit_report_labels');
    const auditMsg = formatAuditAssistantSummary(imported);
    if (auditMsg) return auditMsg;

    const s = imported.summary || {};
    return (
        `**Сверка готова:** ${imported.title}\n\n` +
        `Совпало: **${s.matched ?? 0}** · только слева: **${s.only_left ?? 0}** · ` +
        `только справа: **${s.only_right ?? 0}** · расхождения: **${s.value_mismatch ?? 0}**`
    );
}

module.exports = { registerReconcileRoutes, formatReconcileAssistantMessage };
