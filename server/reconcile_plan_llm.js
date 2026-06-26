const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');
const {
    inferCounterpartColumn,
    isAuditResultTableIntent,
    isOpifBrokerAudit,
    isOpifLegacyAudit,
    parseReconcileIntent,
} = require('./reconcile_intent');
const {
    AUDIT_SCENARIOS,
    formatAuditScenariosForPrompt,
    detectAuditScenario,
    applyAuditScenarioPlan,
} = require('./audit_scenarios');

function formatSourcesForPrompt(sources) {
    return (sources || [])
        .map((s) => {
            const sample = JSON.stringify(s.sampleRows || []).slice(0, 600);
            const flags = [
                s.reconcileReport ? 'reconcile_report' : null,
                s.hasBrokerAudit ? 'hasBrokerFound' : null,
                s.auditScenarioId ? `audit:${s.auditScenarioId}` : null,
            ]
                .filter(Boolean)
                .join(', ');
            return (
                `- ref: ${s.ref}\n  label: ${s.label}\n  headers: ${JSON.stringify(s.headers || [])}` +
                (flags ? `\n  flags: ${flags}` : '') +
                `\n  sample: ${sample}`
            );
        })
        .join('\n');
}

function buildReconcilePlannerPrompt({ message, catalog }) {
    return `Ты — Martin, помощник аудитора. Построй ПЛАН сверки. НЕ сопоставляй строки — только план для скрипта.

Доступные источники (ref обязателен):
${formatSourcesForPrompt(catalog.sources)}

Активная таблица: ${catalog.activeSnapshotId ? `snapshot:${catalog.activeSnapshotId}` : '(нет)'}

Правила выбора сценария:
- «аудит с брокером» → opif_uk_broker: left=УК, right=брокер, новая вкладка
- «сверь с депо» (без брокера) → opif_uk_depo: left=УК, right=ДЕПО, новая вкладка
- «полный аудит» / «брокер и депо» → opif_three_way: left=УК, broker=брокер, depo=ДЕПО, новая вкладка
- «добавь депо» при активном отчёте с brokerFound → opif_enrich_depo: left=активный отчёт, right=ДЕПО, in-place
«Результат в новую таблицу» = новый reconcile_report, НЕ копия одной таблицы.

Каталог сценариев ОПИФ:
${formatAuditScenariosForPrompt()}

Для opif_uk_broker и opif_uk_depo: securityMatch=false, legacy-матчер (не generic reconcile).

Запрос аудитора:
${String(message || '')}

Верни ТОЛЬКО JSON:
{
  "left": { "ref": "snapshot:123", "label": "краткое имя" },
  "right": { "ref": "snapshot:456", "label": "краткое имя" },
  "broker": { "ref": "snapshot:456", "label": "брокер" },
  "depo": { "ref": "snapshot:789", "label": "депо" },
  "leftKeys": ["period", "regNum"],
  "rightKeys": ["period", "regNum"],
  "valuePairs": [{ "left": "quantity", "right": "Количество", "tolerance": 0.01 }],
  "normalizers": [],
  "join": "enrich_left",
  "securityMatch": false,
  "auditScenarioId": "opif_uk_broker",
  "matcher": "opif_legacy_broker",
  "outputMode": "new_snapshot",
  "reportLabel": "Аудит",
  "explanation": "1-2 предложения"
}

Правила:
- left/right.ref — только из списка источников
- opif_three_way: обязательны left, broker, depo (три разных ref)
- opif_enrich_depo: left = активный отчёт, right = depo, outputMode=enrich_active
- Не придумывай колонки, которых нет в headers`;
}

function sanitizePlan(raw, catalog, message = '') {
    const regexPlan = parseReconcileIntent(message, catalog);
    if (regexPlan && isOpifLegacyAudit(message, regexPlan)) {
        return regexPlan;
    }

    const sources = catalog?.sources || [];
    const validRefs = new Set(sources.map((s) => s.ref));

    const plan = {
        left: raw?.left || null,
        right: raw?.right || null,
        broker: raw?.broker || null,
        depo: raw?.depo || null,
        leftKeys: Array.isArray(raw?.leftKeys) ? raw.leftKeys.map(String) : [],
        rightKeys: Array.isArray(raw?.rightKeys) ? raw.rightKeys.map(String) : [],
        valuePairs: Array.isArray(raw?.valuePairs) ? raw.valuePairs : [],
        normalizers: Array.isArray(raw?.normalizers) ? raw.normalizers : [],
        join: ['inner', 'enrich_left', 'audit_enrich', 'enrich_active', 'three_way'].includes(raw?.join)
            ? raw.join
            : 'outer',
        dateFallback: raw?.dateFallback !== false,
        securityMatch: raw?.securityMatch === true,
        auditScenarioId: raw?.auditScenarioId ? String(raw.auditScenarioId) : null,
        matcher: raw?.matcher ? String(raw.matcher) : null,
        outputMode: raw?.outputMode ? String(raw.outputMode) : null,
        reportLabel: String(raw?.reportLabel || (isAuditResultTableIntent(message) ? 'Аудит' : 'Сверка')).trim(),
        explanation: String(raw?.explanation || '').trim(),
        planner: 'llm',
    };

    if (!plan.left?.ref || !validRefs.has(plan.left.ref)) return regexPlan || null;

    if (plan.auditScenarioId === 'opif_three_way' || plan.matcher === 'opif_legacy_three') {
        if (!plan.broker?.ref || !validRefs.has(plan.broker.ref)) return regexPlan || null;
        if (!plan.depo?.ref || !validRefs.has(plan.depo.ref)) return regexPlan || null;
        plan.right = plan.depo;
    } else if (plan.auditScenarioId === 'opif_enrich_depo' || plan.outputMode === 'enrich_active') {
        if (!plan.right?.ref || !validRefs.has(plan.right.ref)) return regexPlan || null;
    } else {
        if (!plan.right?.ref || !validRefs.has(plan.right.ref)) return regexPlan || null;
        if (plan.left.ref === plan.right.ref) return regexPlan || null;
    }

    const leftSrc = sources.find((s) => s.ref === plan.left.ref);
    const rightSrc = sources.find((s) => s.ref === plan.right?.ref);
    const brokerSrc = sources.find((s) => s.ref === plan.broker?.ref);
    const depoSrc = sources.find((s) => s.ref === plan.depo?.ref);
    const leftHeaders = leftSrc?.headers || [];
    const rightHeaders = rightSrc?.headers || [];

    if (!plan.rightKeys.length) {
        plan.rightKeys = plan.leftKeys
            .map((k) => inferCounterpartColumn(k, rightHeaders) || (rightHeaders.includes(k) ? k : null))
            .filter(Boolean);
    }
    if (!plan.rightKeys.length) plan.rightKeys = [...plan.leftKeys];

    if (isAuditResultTableIntent(message) || isOpifBrokerAudit(message)) {
        plan.join = plan.join === 'enrich_active' ? 'enrich_active' : 'enrich_left';
        plan.dateFallback = true;
    }

    const detected = detectAuditScenario(message, catalog, leftSrc, rightSrc, brokerSrc, depoSrc);
    if (detected) {
        Object.assign(plan, applyAuditScenarioPlan(plan, detected.scenario, leftHeaders, rightHeaders));
    } else if (plan.auditScenarioId && AUDIT_SCENARIOS[plan.auditScenarioId]) {
        Object.assign(
            plan,
            applyAuditScenarioPlan(plan, AUDIT_SCENARIOS[plan.auditScenarioId], leftHeaders, rightHeaders)
        );
    }

    return plan;
}

async function planReconciliationWithLlm({ message, catalog, useLlm = true }) {
    const regexPlan = parseReconcileIntent(message, catalog);
    if (!useLlm) return regexPlan;

    try {
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: 'Отвечай только JSON.' },
                { role: 'user', content: buildReconcilePlannerPrompt({ message, catalog }) },
            ],
            temperature: 0.1,
            responseFormat: { type: 'json_object' },
        });
        const parsed = extractJsonFromLlmContent(content);
        const llmPlan = sanitizePlan(parsed, catalog, message);
        if (llmPlan) return llmPlan;
    } catch {
        /* fallback */
    }
    return regexPlan;
}

module.exports = {
    buildReconcilePlannerPrompt,
    planReconciliationWithLlm,
    sanitizePlan,
};
