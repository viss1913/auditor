const VALUE_LABELS = {
    quantity: 'количество',
    amount: 'сумма',
    regNum: 'рег.номер',
    isin: 'ISIN',
};

const MATCH_BY_LABELS = {
    isin: 'по ISIN',
    regNum: 'по рег.номеру',
    'name+suffix': 'по названию и типу (ап/ао)',
    name: 'по названию',
    security: 'по бумаге',
};

function labelAuditMatchBy(code) {
    const key = String(code || '').trim();
    return MATCH_BY_LABELS[key] || key;
}

function formatAuditResult(status) {
    if (status === 'match') return 'Найдено';
    if (status === 'only_left') return 'Не найдено в брокере';
    if (status === 'value_mismatch') return 'Расхождение';
    if (status === 'only_right') return 'Только у брокера';
    return String(status || '');
}

function buildAuditComment(status, mismatchCols = [], leftRow = {}, rightRow = {}, valuePairs = []) {
    if (status === 'match') {
        return 'Строка брокера найдена, количество и сумма совпали';
    }
    if (status === 'only_left') {
        const date = leftRow.period || leftRow.registrationDate || '';
        const paper = leftRow.name || leftRow._security_core_name || '';
        return `В брокере нет сделки: дата ${date || '?'}, бумага «${paper || '?'}»`;
    }
    if (status === 'value_mismatch') {
        const parts = (mismatchCols || []).map((col) => {
            const pair = valuePairs.find((p) => p.left === col) || { left: col, right: col };
            const label = VALUE_LABELS[col] || col;
            const lv = leftRow[pair.left] ?? '—';
            const rv = rightRow?.[pair.right] ?? '—';
            return `${label}: УК ${lv} ≠ брокер ${rv}`;
        });
        return parts.length ? parts.join('; ') : 'Есть отличия в сверяемых полях';
    }
    return '';
}

function decorateAuditRow(row, { valuePairs = [] } = {}) {
    const status = row.reconcile_status || '';
    const mismatchCols = row._reconcile_mismatch_columns || [];
    const rightRow = {};
    for (const [k, v] of Object.entries(row)) {
        if (k.startsWith('broker_')) rightRow[k.slice(7)] = v;
    }

    return {
        audit_result: formatAuditResult(status),
        audit_comment: buildAuditComment(status, mismatchCols, row, rightRow, valuePairs),
        audit_match_by_label: row.audit_match_by ? labelAuditMatchBy(row.audit_match_by) : '',
    };
}

const UK_COLUMN_ORDER = [
    'period',
    'name',
    'regNum',
    'isin',
    'quantity',
    'amount',
    'operationType',
    'document',
    'credit_account',
    'debit_account',
];

const BROKER_COLUMN_ORDER = [
    'broker_registrationDate',
    'broker_period',
    'broker_name',
    'broker_regNum',
    'broker_isin',
    'broker_quantity',
    'broker_amount',
    'broker_operationType',
];

const TECH_COLUMNS = [
    'reconcile_status',
    'audit_match_by',
    'audit_security_key',
    'reconcile_key',
    '_security_key',
    '_security_core_name',
    '_security_isin',
    '_security_reg_num',
];

function buildAuditEnrichHeaders(leftHeaders = [], rowSample = {}) {
    const skip = (h) =>
        !h ||
        h.startsWith('_security_match') ||
        h === '_reconcile_mismatch_columns' ||
        TECH_COLUMNS.includes(h);

    const leftClean = (leftHeaders || []).filter((h) => !skip(h));
    const orderedLeft = [];
    for (const h of UK_COLUMN_ORDER) {
        if (leftClean.includes(h)) orderedLeft.push(h);
    }
    for (const h of leftClean) {
        if (!orderedLeft.includes(h) && !h.startsWith('audit_')) orderedLeft.push(h);
    }

    const brokerPresent = BROKER_COLUMN_ORDER.filter(
        (h) => rowSample[h] !== undefined && rowSample[h] !== ''
    );
    const brokerCols = brokerPresent.length ? brokerPresent : BROKER_COLUMN_ORDER;

    return [
        'audit_result',
        'audit_comment',
        'audit_match_by_label',
        ...orderedLeft,
        ...brokerCols,
        'reconcile_status',
    ];
}

function formatAuditAssistantSummary(imported) {
    const s = imported.summary || {};
    const scenarioId = imported.tableMeta?.auditScenarioId || s.auditScenarioId;
    if (!scenarioId) return null;

    if (scenarioId === 'opif_uk_depo') {
        return (
            `**Аудит УК ↔ ДЕПО готов:** ${imported.title}\n\n` +
            `✅ Найдено в ДЕПО: **${s.matched ?? 0}** · ` +
            `❌ Не найдено: **${s.only_left ?? 0}**\n\n` +
            `Смотри **depoFound**, **audit_depo**, **ukGroupQty** / **depoGroupQty**.`
        );
    }

    if (scenarioId === 'opif_three_way') {
        return (
            `**Полный аудит готов:** ${imported.title}\n\n` +
            `✅ Обе стороны OK: **${s.matched ?? 0}** · ` +
            `❌ Не найдено: **${s.only_left ?? 0}** · ` +
            `⚠️ Частично: **${s.value_mismatch ?? 0}**\n\n` +
            `Зелёная строка = **brokerFound** и **depoFound**.`
        );
    }

    return (
        `**Аудит готов:** ${imported.title}\n\n` +
        `✅ Найдено: **${s.matched ?? 0}** · ` +
        `❌ Не найдено в брокере: **${s.only_left ?? 0}** · ` +
        `⚠️ Расхождения (кол-во/сумма): **${s.value_mismatch ?? 0}**\n\n` +
        `Смотри колонки **audit_result** и **audit_comment** — там по-русски по каждой строке.`
    );
}

module.exports = {
    formatAuditResult,
    buildAuditComment,
    labelAuditMatchBy,
    decorateAuditRow,
    buildAuditEnrichHeaders,
    formatAuditAssistantSummary,
};
