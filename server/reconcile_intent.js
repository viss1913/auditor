const { inferValuePairs } = require('./reconcile_engine');
const {
    detectAuditScenario,
    applyAuditScenarioPlan,
    sourceRole,
    getActiveSourceMeta,
    activeMatchesEnrich,
    isOpifLegacyMatcher,
    AUDIT_SCENARIOS,
} = require('./audit_scenarios');

function looksLikeReconcileIntent(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (/(?:сверь|сверк\w*|сверя\w*|сопостав\w*|сравн\w*)/i.test(t)) {
        return true;
    }
    if (/(?:^|[\s,.:;!?])аудит(?:[\s,.:;!?]|$)/i.test(t) || /(?:^|[\s,.:;!?])audit(?:[\s,.:;!?]|$)/i.test(t)) {
        return true;
    }
    if (/\breconcile\b/i.test(t)) return true;
    if (/\bcompare\b/i.test(t) && /\bwith\b/i.test(t)) return true;
    if (/сверя\w*\s+с\s+/i.test(t)) return true;
    if (/сопостав\w*\s+с\s+/i.test(t)) return true;
    if (/добав\w*\s+.*депо/i.test(t) || /дополни\w*\s+.*депо/i.test(t)) return true;
    return false;
}

function isAuditResultTableIntent(text) {
    const t = String(text || '');
    if (!looksLikeReconcileIntent(t)) return false;
    return /(?:результат\s+)?(?:в\s+)?нов[а-яёa-z0-9]*\s+таблиц[а-яёa-z0-9]*/i.test(t);
}

function pickSourceByLabel(sources, hint) {
    const h = String(hint || '').trim().toLowerCase();
    if (!h) return null;
    const list = sources || [];
    const exact = list.find((s) => String(s.label || '').toLowerCase() === h);
    if (exact) return exact.ref;
    const partial = list.find((s) => {
        const label = String(s.label || '').toLowerCase();
        const path = String(s.relativePath || s.sourceFileName || '').toLowerCase();
        return label.includes(h) || h.includes(label) || path.includes(h);
    });
    return partial?.ref || null;
}

function sourceHaystack(source) {
    return `${source?.label || ''} ${source?.scenarioId || ''} ${source?.sourceFileName || ''} ${source?.relativePath || ''}`.toLowerCase();
}

function findSourceByRole(sources, role) {
    const ready = (sources || []).filter((s) => s.headers?.length);
    if (role === 'broker') {
        return ready.find((s) => /broker|брокер|opif_broker/i.test(sourceHaystack(s))) || null;
    }
    if (role === 'depo') {
        return ready.find((s) => /depo|депо|opif_depo/i.test(sourceHaystack(s))) || null;
    }
    if (role === 'uk') {
        return (
            ready.find((s) => /uk_journal|карт|58\.1|journal_58/i.test(sourceHaystack(s))) ||
            ready.find((s) => !/broker|брокер|depo|депо/i.test(sourceHaystack(s))) ||
            null
        );
    }
    return null;
}

function resolveColumnInHeaders(token, headers = []) {
    const raw = String(token || '').trim();
    if (!raw || !headers?.length) return null;
    if (headers.includes(raw)) return raw;
    const lower = raw.toLowerCase();
    const exact = headers.find((h) => String(h).toLowerCase() === lower);
    if (exact) return exact;
    const partial = headers.find((h) => String(h).toLowerCase().includes(lower) || lower.includes(String(h).toLowerCase()));
    return partial || null;
}

const COLUMN_ALIASES = {
    period: ['period', 'дата', 'date'],
    registrationdate: ['registrationdate', 'registration_date', 'дата рег', 'дата регистрации'],
    name: ['name', 'название', 'ценная бумага', 'бумага'],
    regnum: ['regnum', 'reg_num', 'рег', 'рег номер', 'рег. №'],
    quantity: ['quantity', 'количество', 'кол во', 'кол-во', 'qty'],
    amount: ['amount', 'сумма', 'sum'],
    isin: ['isin'],
};

function inferCounterpartColumn(col, otherHeaders = []) {
    if (!col) return null;
    const lower = String(col).toLowerCase();
    if (lower === 'period' && otherHeaders.includes('registrationDate')) return 'registrationDate';
    if (lower === 'registrationdate' && otherHeaders.includes('period')) return 'period';
    return resolveColumnInHeaders(col, otherHeaders);
}

function parseTokenList(fragment) {
    return String(fragment || '')
        .split(/\s*,\s*|\s+и\s+|;\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
}

function parseKeysAndPairsFromMessage(message, leftHeaders, rightHeaders) {
    const t = String(message || '');
    let leftKeys = [];
    let rightKeys = [];
    let valuePairs = [];

    const keysMatch = t.match(/(?:^|\s)по\s+([^;]+?)(?:\s*;\s*сравн|\s*;\s*сверь|\s*;\s*результат|[.;]|$)/i);
    if (keysMatch) {
        for (const token of parseTokenList(keysMatch[1])) {
            const leftCol = resolveColumnInHeaders(token, leftHeaders);
            const rightCol = resolveColumnInHeaders(token, rightHeaders);
            if (leftCol && rightCol) {
                if (!leftKeys.includes(leftCol)) leftKeys.push(leftCol);
                if (!rightKeys.includes(rightCol)) rightKeys.push(rightCol);
            } else if (leftCol) {
                const mappedRight = inferCounterpartColumn(leftCol, rightHeaders) || leftCol;
                if (!leftKeys.includes(leftCol)) leftKeys.push(leftCol);
                if (!rightKeys.includes(mappedRight)) rightKeys.push(mappedRight);
            } else if (rightCol) {
                const mappedLeft = inferCounterpartColumn(rightCol, leftHeaders) || rightCol;
                if (!rightKeys.includes(rightCol)) rightKeys.push(rightCol);
                if (!leftKeys.includes(mappedLeft)) leftKeys.push(mappedLeft);
            }
        }
    }

    const compareMatch = t.match(/(?:^|\s)сравн[а-яё]*\s+([^.;]+?)(?:[.;]|$)/i);
    if (compareMatch) {
        for (const token of parseTokenList(compareMatch[1])) {
            const leftCol = resolveColumnInHeaders(token, leftHeaders);
            const rightCol = resolveColumnInHeaders(token, rightHeaders) || inferCounterpartColumn(leftCol, rightHeaders);
            if (leftCol && rightCol) {
                valuePairs.push({ left: leftCol, right: rightCol, tolerance: 0.01 });
            }
        }
    }

    return { leftKeys, rightKeys, valuePairs };
}

function isOpifBrokerAudit(message) {
    const t = String(message || '').toLowerCase();
    return looksLikeReconcileIntent(message) && /брокер/i.test(t) && !/депо/i.test(t);
}

function isOpifDepoAudit(message) {
    const t = String(message || '').toLowerCase();
    return looksLikeReconcileIntent(message) && /депо/i.test(t) && !/брокер/i.test(t);
}

function isOpifThreeWayAudit(message) {
    const t = String(message || '').toLowerCase();
    return looksLikeReconcileIntent(message) && /брокер/i.test(t) && /депо/i.test(t);
}

function isEnrichDepoIntent(message, catalog = {}) {
    const t = String(message || '').toLowerCase();
    if (!/добав|дополни/i.test(t) || !/депо/i.test(t)) return false;
    return activeMatchesEnrich(getActiveSourceMeta(catalog));
}

function isOpifLegacyAudit(message, plan = null) {
    if (plan?.matcher && isOpifLegacyMatcher(plan.matcher)) return true;
    const t = String(message || '').toLowerCase();
    if (!looksLikeReconcileIntent(message)) return false;
    return (
        isOpifBrokerAudit(message) ||
        isOpifDepoAudit(message) ||
        isOpifThreeWayAudit(message) ||
        isEnrichDepoIntent(message)
    );
}

function defaultOpifAuditKeys(leftHeaders, rightHeaders) {
    const leftKeys = [];
    if (leftHeaders.includes('period')) leftKeys.push('period');
    else if (leftHeaders.includes('registrationDate')) leftKeys.push('registrationDate');
    if (leftHeaders.includes('name')) leftKeys.push('name');

    const rightKeys = [];
    if (rightHeaders.includes('registrationDate')) rightKeys.push('registrationDate');
    else if (rightHeaders.includes('period')) rightKeys.push('period');
    if (rightHeaders.includes('name')) rightKeys.push('name');

    return { leftKeys, rightKeys };
}

function guessKeys(headers, message, options = {}) {
    const t = String(message || '').toLowerCase();
    const opifAudit = options.opifAudit || isOpifBrokerAudit(message);

    if (opifAudit) {
        const { leftKeys } = defaultOpifAuditKeys(headers, []);
        if (leftKeys.length) return leftKeys;
    }

    const candidates = [
        'period',
        'registrationDate',
        'regNum',
        'name',
        'isin',
        'operation_type',
        'operationType',
        'document',
    ];
    const fromMsg = [];
    for (const c of candidates) {
        const aliases = COLUMN_ALIASES[c.toLowerCase()] || [c.toLowerCase()];
        if (aliases.some((a) => t.includes(a)) && headers.includes(c)) fromMsg.push(c);
    }
    if (fromMsg.length) {
        const keys = opifAudit ? fromMsg.filter((c) => c !== 'regNum').slice(0, 2) : fromMsg.slice(0, 3);
        if (keys.length) return keys;
    }
    const shared = candidates.filter((c) => headers.includes(c));
    return shared.length ? shared.slice(0, 2) : headers.slice(0, 1);
}

function hasUkLikeHeaders(headers = []) {
    const set = new Set((headers || []).map((h) => String(h).toLowerCase()));
    return ['period', 'name'].every((h) => set.has(h));
}

/**
 * База аудита слева: активная вкладка (УК / отчёт аудита), иначе карт 58.1.
 * Если активен брокер/депо — не берём его слева при сверке с брокером/депо.
 */
function pickLeftForAudit(ready, activeId, rightRef, { enrichMode = false } = {}) {
    const activeRef = activeId ? `snapshot:${activeId}` : null;
    const rightSrc = ready.find((s) => s.ref === rightRef);
    const rightRole = rightSrc ? sourceRole(rightSrc) : null;
    const activeSrc = activeRef ? ready.find((s) => s.ref === activeRef) : null;
    const activeRole = activeSrc ? sourceRole(activeSrc) : null;

    if (enrichMode && activeRef) return activeRef;

    if (activeRef && activeRef !== rightRef) {
        if (activeRole === 'audit_report') return activeRef;
        if (activeRole === 'uk') return activeRef;
        if (activeRole === 'unknown' && rightRole === 'broker' && hasUkLikeHeaders(activeSrc?.headers)) {
            return activeRef;
        }
        if (activeRole !== 'broker' && activeRole !== 'depo') return activeRef;
    }

    const uk = findSourceByRole(ready, 'uk');
    if (uk && uk.ref !== rightRef) return uk.ref;

    return ready.find((s) => s.ref !== rightRef)?.ref || null;
}

function resolveReconcileSources(message, catalog = {}) {
    const sources = catalog.sources || [];
    const ready = sources.filter((s) => s.headers?.length);
    const activeId = catalog.activeSnapshotId;
    const msg = String(message || '').toLowerCase();

    let leftRef = null;
    let rightRef = null;
    let brokerRef = null;
    let depoRef = null;

    if (isEnrichDepoIntent(message, catalog)) {
        const depo = findSourceByRole(ready, 'depo');
        depoRef = depo?.ref || null;
        rightRef = depoRef;
        leftRef = activeId ? `snapshot:${activeId}` : null;
        return { leftRef, rightRef, brokerRef, depoRef, ready };
    }

    const pairMatch = String(message).match(/сверь\s+(.+?)\s+с\s+(.+?)(?:\s+по|\s*$|\.)/i);
    if (pairMatch) {
        leftRef = pickSourceByLabel(sources, pairMatch[1]);
        rightRef = pickSourceByLabel(sources, pairMatch[2]);
    }

    const broker = findSourceByRole(ready, 'broker');
    const depo = findSourceByRole(ready, 'depo');

    if (isOpifThreeWayAudit(message)) {
        brokerRef = broker?.ref || null;
        depoRef = depo?.ref || null;
        leftRef = pickLeftForAudit(ready, activeId, brokerRef);
        rightRef = depoRef;
        return { leftRef, rightRef, brokerRef, depoRef, ready };
    }

    if (/брокер/i.test(msg)) {
        if (broker) {
            brokerRef = broker.ref;
            rightRef = broker.ref;
        }
    }
    if (/депо/i.test(msg) && !brokerRef) {
        if (depo) {
            depoRef = depo.ref;
            rightRef = depo.ref;
        }
    }

    const auditLike =
        isAuditResultTableIntent(message) ||
        (looksLikeReconcileIntent(message) && /аудит/i.test(msg));
    const explicitActive = /(?:текущ|открыт|активн|на\s+экране)/i.test(msg) || /берем\s+строк/i.test(msg);
    const opifCounterparty = /брокер|депо/i.test(msg);

    if (!pairMatch) {
        if (rightRef && (auditLike || opifCounterparty)) {
            leftRef = pickLeftForAudit(ready, activeId, rightRef);
        } else if ((explicitActive || auditLike) && activeId) {
            leftRef = `snapshot:${activeId}`;
        } else if (/ук|карт|58\.1/i.test(msg)) {
            const uk = findSourceByRole(ready, 'uk');
            if (uk) leftRef = uk.ref;
        }
    }

    if (!leftRef && activeId && rightRef) {
        leftRef = pickLeftForAudit(ready, activeId, rightRef);
    } else if (!leftRef && activeId && !rightRef && ready.length >= 2) {
        leftRef = `snapshot:${activeId}`;
    }

    if (!leftRef && !rightRef && ready.length === 2) {
        if (broker) {
            rightRef = broker.ref;
            brokerRef = broker.ref;
            leftRef = ready.find((s) => s.ref !== rightRef)?.ref || null;
        } else {
            leftRef = ready[0].ref;
            rightRef = ready[1].ref;
        }
    } else if (!rightRef && leftRef) {
        rightRef = ready.find((s) => s.ref !== leftRef)?.ref || null;
    } else if (!leftRef && rightRef) {
        leftRef = ready.find((s) => s.ref !== rightRef)?.ref || null;
    }

    if (brokerRef == null && rightRef && broker?.ref === rightRef) brokerRef = rightRef;
    if (depoRef == null && rightRef && depo?.ref === rightRef) depoRef = rightRef;

    return { leftRef, rightRef, brokerRef, depoRef, ready };
}

function buildReconcileClarification(message, catalog = {}) {
    const { ready, leftRef, brokerRef, depoRef } = resolveReconcileSources(message, catalog);

    if (isOpifThreeWayAudit(message)) {
        const missing = [];
        if (!leftRef || sourceRole(ready.find((s) => s.ref === leftRef)) === 'broker') {
            missing.push('УК (карт 58.1)');
        }
        if (!brokerRef) missing.push('брокер (opif_broker)');
        if (!depoRef) missing.push('ДЕПО (opif_depo)');
        if (missing.length) {
            return {
                needsClarification: true,
                assistantMessage:
                    `Для **полного аудита** нужны три таблицы: УК, брокер и ДЕПО.\n\n` +
                    `Не хватает: **${missing.join(', ')}**. Разбери файлы или укажи таблицы явно.`,
                questions: [],
            };
        }
    }

    if (isEnrichDepoIntent(message, catalog) && !depoRef) {
        return {
            needsClarification: true,
            assistantMessage:
                'Хочу дополнить отчёт аудита колонками ДЕПО, но **нет таблицы ДЕПО** в чате. ' +
                'Сначала разбери выписки opif_depo.',
            questions: [],
        };
    }

    if (!isEnrichDepoIntent(message, catalog) && ready.length < 2) {
        return {
            needsClarification: true,
            assistantMessage:
                'Для сверки нужно минимум **2 готовые таблицы** в этом чате (например УК и брокер). ' +
                'Сначала разбери файлы, потом напиши «сверь УК с брокером».',
            questions: [],
        };
    }

    const auto = parseReconcileIntent(message, catalog);
    if (auto) return null;

    const options = ready.map((s) => ({
        value: s.ref,
        label: `${s.label} (${(s.rowCount ?? '?').toLocaleString?.('ru-RU') ?? s.rowCount} строк)`,
    }));

    return {
        needsClarification: true,
        assistantMessage:
            'Могу сверить таблицы, но не поняла **какие именно** и **по каким ключам**.\n\n' +
            `Доступно: ${options.map((o) => `• ${o.label}`).join('\n')}\n\n` +
            'Напиши, например: **сверь текущую таблицу с брокером по period и registrationDate, name; сравни quantity, amount**',
        questions: [
            {
                id: 'pick_reconcile_sources',
                promptTemplate:
                    'Какие две таблицы сверить? Укажи слева и справа, например: «УК с брокером».',
                options,
            },
        ],
    };
}

/**
 * Regex-план сверки без LLM.
 */
function parseReconcileIntent(message, catalog = {}) {
    if (!looksLikeReconcileIntent(message)) return null;

    const { leftRef, rightRef, brokerRef, depoRef, ready } = resolveReconcileSources(message, catalog);

    if (isEnrichDepoIntent(message, catalog)) {
        if (!leftRef || !rightRef || leftRef === rightRef) return null;
        const left = ready.find((s) => s.ref === leftRef) || catalog.sources?.find((s) => s.ref === leftRef);
        const right = ready.find((s) => s.ref === rightRef) || catalog.sources?.find((s) => s.ref === rightRef);
        if (!left || !right) return null;
        return applyAuditScenarioPlan(
            {
                left: { ref: leftRef, label: left.label },
                right: { ref: rightRef, label: right.label },
                planner: 'audit_scenario',
                reportLabel: 'Аудит',
            },
            AUDIT_SCENARIOS.opif_enrich_depo,
            left.headers || [],
            right.headers || []
        );
    }

    if (isOpifThreeWayAudit(message)) {
        if (!leftRef || !brokerRef || !depoRef) return null;
        const left = ready.find((s) => s.ref === leftRef);
        const broker = ready.find((s) => s.ref === brokerRef);
        const depo = ready.find((s) => s.ref === depoRef);
        if (!left || !broker || !depo) return null;
        return applyAuditScenarioPlan(
            {
                left: { ref: leftRef, label: left.label },
                right: { ref: depoRef, label: depo.label },
                broker: { ref: brokerRef, label: broker.label },
                depo: { ref: depoRef, label: depo.label },
                planner: 'audit_scenario',
                reportLabel: 'Аудит',
            },
            AUDIT_SCENARIOS.opif_three_way,
            left.headers || [],
            depo.headers || []
        );
    }

    if (!leftRef || !rightRef || leftRef === rightRef) return null;

    const left = ready.find((s) => s.ref === leftRef) || catalog.sources?.find((s) => s.ref === leftRef);
    const right = ready.find((s) => s.ref === rightRef) || catalog.sources?.find((s) => s.ref === rightRef);
    if (!left || !right) return null;

    const leftHeaders = left.headers || [];
    const rightHeaders = right.headers || [];

    const parsed = parseKeysAndPairsFromMessage(message, leftHeaders, rightHeaders);
    let leftKeys = parsed.leftKeys;
    let rightKeys = parsed.rightKeys;
    let valuePairs = parsed.valuePairs;

    const opifAudit = isOpifBrokerAudit(message) || isOpifDepoAudit(message);
    const auditTable = isAuditResultTableIntent(message);

    if (!leftKeys.length) leftKeys = guessKeys(leftHeaders, message, { opifAudit: isOpifBrokerAudit(message) });
    if (!rightKeys.length) {
        if (isOpifBrokerAudit(message)) {
            const defaults = defaultOpifAuditKeys(leftHeaders, rightHeaders);
            rightKeys = defaults.rightKeys.length ? defaults.rightKeys : leftKeys
                .map((k) => inferCounterpartColumn(k, rightHeaders) || (rightHeaders.includes(k) ? k : null))
                .filter(Boolean);
        } else {
            rightKeys = leftKeys
                .map((k) => inferCounterpartColumn(k, rightHeaders) || (rightHeaders.includes(k) ? k : null))
                .filter(Boolean);
        }
    }
    if (!rightKeys.length) rightKeys = guessKeys(rightHeaders, message, { opifAudit: isOpifBrokerAudit(message) });

    if (!valuePairs.length) {
        if (isOpifBrokerAudit(message)) {
            const compareCols = ['quantity', 'amount', 'regNum'].filter(
                (c) => leftHeaders.includes(c) && rightHeaders.includes(c)
            );
            valuePairs = compareCols.map((col) => ({ left: col, right: col, tolerance: 0.01 }));
        }
        if (!valuePairs.length) {
            valuePairs = inferValuePairs(leftHeaders, rightHeaders, { leftKeys, rightKeys });
        }
    }

    const reportLabel = auditTable || (opifAudit && /аудит/i.test(message)) ? 'Аудит' : 'Сверка';

    let plan = {
        left: { ref: leftRef, label: left.label },
        right: { ref: rightRef, label: right.label },
        leftKeys,
        rightKeys,
        valuePairs,
        join: auditTable || opifAudit ? 'enrich_left' : 'outer',
        dateFallback: true,
        planner: 'regex',
        reportLabel,
        explanation:
            `${reportLabel}: «${left.label}» ↔ «${right.label}» по ключам ` +
            `${leftKeys.join(' + ')} ↔ ${rightKeys.join(' + ')}`,
    };

    const broker = brokerRef ? ready.find((s) => s.ref === brokerRef) : null;
    const depo = depoRef ? ready.find((s) => s.ref === depoRef) : null;
    const detected = detectAuditScenario(message, catalog, left, right, broker, depo);
    if (detected) {
        plan = applyAuditScenarioPlan(plan, detected.scenario, leftHeaders, rightHeaders);
        plan.planner = 'audit_scenario';
        plan.detectScore = detected.score;
    }

    return plan;
}

module.exports = {
    looksLikeReconcileIntent,
    isAuditResultTableIntent,
    isOpifBrokerAudit,
    isOpifDepoAudit,
    isOpifThreeWayAudit,
    isEnrichDepoIntent,
    isOpifLegacyAudit,
    parseReconcileIntent,
    pickSourceByLabel,
    resolveReconcileSources,
    buildReconcileClarification,
    parseKeysAndPairsFromMessage,
    guessKeys,
    defaultOpifAuditKeys,
};
