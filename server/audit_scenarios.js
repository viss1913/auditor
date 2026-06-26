/**
 * Пресеты аудита / сверки — как Martin понимает «сделай аудит таких данных».
 * Единый каталог сценариев: matcher, outputMode, фразы, колонки.
 */

const AUDIT_SCENARIOS = {
    opif_uk_broker: {
        id: 'opif_uk_broker',
        name: 'ОПИФ: аудит УК ↔ брокер',
        description:
            'Активная/УК-таблица слева, брокер справа. Построчный матч: дата рег. + buy/sell + reg/ISIN + qty/amount.',
        userPhrases: [
            'аудит с брокером',
            'сверь с брокером',
            'результат в новую таблицу',
            'нашли не нашли',
        ],
        counterparties: ['broker'],
        matcher: 'opif_legacy_broker',
        outputMode: 'new_snapshot',
        columnsAdded: ['brokerFound', 'audit_result', 'audit_comment', 'broker_*', 'reconcile_status'],
        rowColorRule: 'зелёный = brokerFound, красный = нет',
        llmHints:
            'left = УК (карт 58.1 или активная вкладка), right = opif_broker. ' +
            'Новая вкладка reconcile_report. securityMatch=false.',
        messagePatterns: [
            /аудит/i,
            /свер[яь]\w*\s+.*брокер/i,
            /сопостав\w*\s+.*брокер/i,
            /брокер.*(?:аудит|свер)/i,
            /нашли\s+не\s+нашли/i,
            /результат\s+в\s+нов/i,
        ],
        requiredRoles: { left: ['uk', 'active'], right: ['broker'] },
        headerHints: {
            left: ['period', 'name', 'quantity', 'amount'],
            right: ['registrationDate', 'name', 'quantity', 'amount'],
        },
        plan: {
            join: 'enrich_left',
            matcher: 'opif_legacy_broker',
            securityMatch: false,
            dateFallback: true,
            leftDateKey: 'period',
            rightDateKey: 'registrationDate',
            leftKeys: ['period', '_security_key'],
            rightKeys: ['registrationDate', '_security_key'],
            valuePairs: [
                { left: 'quantity', right: 'quantity', tolerance: 0.01 },
                { left: 'amount', right: 'amount', tolerance: 0.01 },
            ],
            reportLabel: 'Аудит',
        },
    },
    opif_uk_depo: {
        id: 'opif_uk_depo',
        name: 'ОПИФ: аудит УК ↔ депозитарий',
        description:
            'УК слева, выписка ДЕПО справа. Агрегат по ключу дата|reg/isin|buy/sell, сверка суммарного quantity.',
        userPhrases: ['сверь с депо', 'аудит с депозитарием', 'сверка с депо'],
        counterparties: ['depo'],
        matcher: 'opif_legacy_depo',
        outputMode: 'new_snapshot',
        columnsAdded: ['depoFound', 'ukGroupQty', 'depoGroupQty', 'audit_depo', 'audit_depo_comment'],
        rowColorRule: 'зелёный = depoFound, красный = нет',
        llmHints:
            'left = УК, right = opif_depo. Агрегат как legacy GET /audit, не security_match. Новая вкладка.',
        messagePatterns: [/аудит/i, /свер[яь]\w*\s+.*депо/i, /депо.*(?:аудит|свер)/i],
        requiredRoles: { left: ['uk', 'active'], right: ['depo'] },
        headerHints: {
            left: ['period', 'name', 'quantity'],
            right: ['registrationDate', 'period', 'name', 'quantity'],
        },
        plan: {
            join: 'enrich_left',
            matcher: 'opif_legacy_depo',
            securityMatch: false,
            dateFallback: true,
            leftDateKey: 'period',
            rightDateKey: 'registrationDate',
            leftKeys: ['period', '_security_key'],
            rightKeys: ['registrationDate', '_security_key'],
            valuePairs: [{ left: 'quantity', right: 'quantity', tolerance: 0.0001 }],
            reportLabel: 'Аудит',
        },
    },
    opif_three_way: {
        id: 'opif_three_way',
        name: 'ОПИФ: полный аудит УК + брокер + ДЕПО',
        description:
            'Три источника: УК, брокер, ДЕПО. Брокер построчно, ДЕПО агрегат. Как legacy App.jsx.',
        userPhrases: [
            'полный аудит',
            'с брокером и депо',
            'брокер и депозитарий',
            'трёхсторонний аудит',
        ],
        counterparties: ['broker', 'depo'],
        matcher: 'opif_legacy_three',
        outputMode: 'new_snapshot',
        columnsAdded: [
            'brokerFound',
            'depoFound',
            'ukGroupQty',
            'depoGroupQty',
            'audit_result',
            'audit_depo',
        ],
        rowColorRule: 'зелёный только если brokerFound && depoFound',
        llmHints:
            'Нужны три таблицы: uk (left), broker (brokerRef), depo (depoRef). ' +
            'Новая вкладка с колонками как в legacy /audit.',
        messagePatterns: [
            /полн\w*\s+аудит/i,
            /брокер.*и.*депо/i,
            /депо.*и.*брокер/i,
            /тр[её]хсторон/i,
            /аудит.*брокер.*депо/i,
            /аудит.*депо.*брокер/i,
        ],
        requiredRoles: { left: ['uk', 'active'], broker: ['broker'], depo: ['depo'] },
        headerHints: {
            left: ['period', 'name', 'quantity', 'amount'],
            broker: ['registrationDate', 'quantity', 'amount'],
            depo: ['registrationDate', 'quantity'],
        },
        plan: {
            join: 'three_way',
            matcher: 'opif_legacy_three',
            securityMatch: false,
            reportLabel: 'Аудит',
        },
    },
    opif_enrich_depo: {
        id: 'opif_enrich_depo',
        name: 'ОПИФ: дополнить отчёт аудита колонками ДЕПО',
        description:
            'Активная вкладка — отчёт с brokerFound. Добавляет depoFound, ukGroupQty, depoGroupQty in-place.',
        userPhrases: [
            'добавь депо',
            'дополни депо',
            'добавь сверку с депо',
            'дополни отчёт колонками депо',
            'в текущую таблицу аудита',
        ],
        counterparties: ['depo'],
        matcher: 'opif_enrich_depo',
        outputMode: 'enrich_active',
        requiredActive: { reconcileReport: true, hasColumns: ['brokerFound'] },
        columnsAdded: ['depoFound', 'ukGroupQty', 'depoGroupQty', 'audit_depo', 'audit_depo_comment'],
        rowColorRule: 'зелёный = brokerFound && depoFound',
        llmHints:
            'left = активный reconcile_report с brokerFound. right = depo. ' +
            'Обновить ту же вкладку, не пересчитывать брокера.',
        messagePatterns: [
            /добав\w*\s+.*депо/i,
            /дополни\w*\s+.*депо/i,
            /добав\w*\s+сверк\w*\s+.*депо/i,
            /в\s+текущ\w*\s+таблиц/i,
            /в\s+отч[её]т/i,
        ],
        requiredRoles: { left: ['active', 'audit_report'], right: ['depo'] },
        plan: {
            join: 'enrich_active',
            matcher: 'opif_enrich_depo',
            securityMatch: false,
            reportLabel: 'Аудит',
        },
    },
    generic_reconcile: {
        id: 'generic_reconcile',
        name: 'Общая сверка двух таблиц',
        description: 'Без security resolver — по явным колонкам из сообщения.',
        userPhrases: ['сверь две таблицы', 'сопоставь'],
        counterparties: [],
        matcher: 'generic',
        outputMode: 'new_snapshot',
        columnsAdded: ['reconcile_status', 'left_*', 'right_*'],
        rowColorRule: 'по reconcile_status',
        llmHints: 'Обычный outer join через reconcile_engine.',
        messagePatterns: [/свер[яь]|сопостав|сравн/i],
        requiredRoles: {},
        plan: {
            join: 'outer',
            securityMatch: false,
        },
    },
};

function sourceHaystack(source) {
    return `${source?.label || ''} ${source?.scenarioId || ''} ${source?.sourceFileName || ''}`.toLowerCase();
}

function sourceRole(source) {
    const h = sourceHaystack(source);
    if (/broker|брокер|opif_broker/.test(h)) return 'broker';
    if (/depo|депо|opif_depo/.test(h)) return 'depo';
    if (/reconcile_report|аудит:/i.test(h) || source?.reconcileReport) return 'audit_report';
    if (/uk_journal|карт|58\.1|journal_58|uk_card/.test(h)) return 'uk';
    return 'unknown';
}

function headersMatchHints(headers = [], hints = []) {
    const set = new Set((headers || []).map((h) => String(h).toLowerCase()));
    const need = hints.filter((h) => set.has(String(h).toLowerCase()));
    return need.length >= Math.min(2, hints.length);
}

function getActiveSourceMeta(catalog = {}) {
    const activeId = catalog.activeSnapshotId;
    if (!activeId) return null;
    const ref = `snapshot:${activeId}`;
    return (catalog.sources || []).find((s) => s.ref === ref) || null;
}

function activeMatchesEnrich(activeMeta) {
    if (!activeMeta) return false;
    const req = AUDIT_SCENARIOS.opif_enrich_depo.requiredActive || {};
    if (req.reconcileReport && !activeMeta.reconcileReport) return false;
    if (req.hasColumns?.length) {
        const headers = activeMeta.headers || [];
        if (!req.hasColumns.every((c) => headers.includes(c))) return false;
    }
    return true;
}

function messageWantsDepoOnly(msg) {
    return /депо/i.test(msg) && !/брокер/i.test(msg);
}

function messageWantsBrokerOnly(msg) {
    return /брокер/i.test(msg) && !/депо/i.test(msg);
}

function messageWantsThreeWay(msg) {
    return /брокер/i.test(msg) && /депо/i.test(msg);
}

function messageWantsEnrichDepo(msg) {
    const t = String(msg || '').toLowerCase();
    return (/добав|дополни/i.test(t) && /депо/i.test(t));
}

function scoreScenario(scenario, { message, left, right, broker, depo, catalog, activeMeta }) {
    let score = 0;
    const msg = String(message || '');

    for (const re of scenario.messagePatterns || []) {
        if (re.test(msg)) score += 2;
    }

    const leftRole = left ? sourceRole(left) : 'unknown';
    const rightRole = right ? sourceRole(right) : 'unknown';
    const brokerRole = broker ? sourceRole(broker) : 'unknown';
    const depoRole = depo ? sourceRole(depo) : 'unknown';
    const req = scenario.requiredRoles || {};

    if (req.left?.includes(leftRole)) score += 4;
    if (req.left?.includes('active') && catalog?.activeSnapshotId && left?.ref === `snapshot:${catalog.activeSnapshotId}`) {
        score += 2;
    }
    if (req.left?.includes('audit_report') && leftRole === 'audit_report') score += 6;
    if (req.right?.includes(rightRole)) score += 4;
    if (req.broker?.includes(brokerRole)) score += 4;
    if (req.depo?.includes(depoRole)) score += 4;

    if (left && headersMatchHints(left.headers, scenario.headerHints?.left || [])) score += 2;
    if (right && headersMatchHints(right.headers, scenario.headerHints?.right || [])) score += 2;
    if (broker && headersMatchHints(broker.headers, scenario.headerHints?.broker || [])) score += 2;
    if (depo && headersMatchHints(depo.headers, scenario.headerHints?.depo || [])) score += 2;

    if (scenario.id === 'opif_enrich_depo') {
        if (activeMatchesEnrich(activeMeta)) score += 8;
        else score -= 4;
        if (messageWantsEnrichDepo(msg)) score += 4;
    }

    if (scenario.id === 'opif_three_way' && messageWantsThreeWay(msg)) score += 6;
    if (scenario.id === 'opif_uk_depo' && messageWantsDepoOnly(msg)) score += 4;
    if (scenario.id === 'opif_uk_depo' && messageWantsEnrichDepo(msg)) score -= 8;
    if (scenario.id === 'opif_uk_broker' && messageWantsBrokerOnly(msg)) score += 4;

    if (scenario.id === 'generic_reconcile') score = Math.min(score, 1);

    return score;
}

/**
 * @returns {{ scenario: object, score: number } | null}
 */
function detectAuditScenario(message, catalog = {}, left = null, right = null, broker = null, depo = null) {
    const activeMeta = getActiveSourceMeta(catalog);
    const msg = String(message || '');

    if (messageWantsEnrichDepo(msg) && activeMatchesEnrich(activeMeta)) {
        return { scenario: AUDIT_SCENARIOS.opif_enrich_depo, score: 20 };
    }

    if (messageWantsThreeWay(msg)) {
        const hit = scoreScenario(AUDIT_SCENARIOS.opif_three_way, {
            message,
            left,
            right,
            broker,
            depo,
            catalog,
            activeMeta,
        });
        if (hit >= 4) return { scenario: AUDIT_SCENARIOS.opif_three_way, score: hit };
    }

    let best = null;
    for (const scenario of Object.values(AUDIT_SCENARIOS)) {
        if (scenario.id === 'generic_reconcile' || scenario.id === 'opif_enrich_depo') continue;
        const score = scoreScenario(scenario, {
            message,
            left,
            right,
            broker,
            depo,
            catalog,
            activeMeta,
        });
        if (!best || score > best.score) best = { scenario, score };
    }
    if (best && best.score >= 4) return best;
    return null;
}

function applyAuditScenarioPlan(basePlan, scenario, leftHeaders, rightHeaders) {
    const preset = scenario?.plan || {};
    const plan = { ...basePlan, ...preset, auditScenarioId: scenario.id, outputMode: scenario.outputMode || 'new_snapshot' };

    if (preset.leftKeys?.length) {
        plan.leftKeys = preset.leftKeys.filter(
            (k) => k.startsWith('_') || leftHeaders.includes(k)
        );
    }
    if (preset.rightKeys?.length) {
        plan.rightKeys = preset.rightKeys.filter(
            (k) => k.startsWith('_') || rightHeaders.includes(k)
        );
    }

    if (preset.valuePairs?.length) {
        plan.valuePairs = preset.valuePairs;
    }

    plan.explanation =
        `${preset.reportLabel || 'Аудит'} (${scenario.name}): ` +
        `${scenario.description || ''}`;

    return plan;
}

function listAuditScenarios() {
    return Object.values(AUDIT_SCENARIOS).map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        matcher: s.matcher,
        outputMode: s.outputMode,
        counterparties: s.counterparties,
        userPhrases: s.userPhrases,
        columnsAdded: s.columnsAdded,
    }));
}

function formatAuditScenariosForPrompt() {
    return listAuditScenarios()
        .filter((s) => s.id !== 'generic_reconcile')
        .map((s) => {
            const lines = [
                `### ${s.id}`,
                `Название: ${s.name}`,
                `Описание: ${s.description}`,
                `matcher: ${s.matcher}, outputMode: ${s.outputMode}`,
                `Контрагенты: ${(s.counterparties || []).join(', ') || '—'}`,
                `Колонки: ${(s.columnsAdded || []).join(', ')}`,
                `Фразы: ${(s.userPhrases || []).slice(0, 4).join('; ')}`,
            ];
            const full = AUDIT_SCENARIOS[s.id];
            if (full?.llmHints) lines.push(`Подсказка: ${full.llmHints}`);
            return lines.join('\n');
        })
        .join('\n\n');
}

function isOpifLegacyMatcher(matcher) {
    return (
        matcher === 'opif_legacy_broker' ||
        matcher === 'opif_legacy_depo' ||
        matcher === 'opif_legacy_three' ||
        matcher === 'opif_enrich_depo' ||
        matcher === 'opif_legacy'
    );
}

module.exports = {
    AUDIT_SCENARIOS,
    detectAuditScenario,
    applyAuditScenarioPlan,
    sourceRole,
    listAuditScenarios,
    formatAuditScenariosForPrompt,
    getActiveSourceMeta,
    activeMatchesEnrich,
    isOpifLegacyMatcher,
};
