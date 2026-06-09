function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

function hasOsvTurnover(row) {
    for (let c = 1; c <= 6; c++) {
        const n = toNum(row[c]);
        if (n !== null && n !== 0) return true;
    }
    return false;
}

function classifyOsvLabel(label) {
    const t = String(label || '').trim();
    if (!t || /^Итого/i.test(t)) return 'skip';
    if (
        /^(Группа учета|Подразделение$|Основное средство|Выводимые данные|Ведомость)/i.test(t) ||
        /^Счет,?\s*Наименование/i.test(t) ||
        /^Счёт,?\s*Наименование/i.test(t) ||
        /^Сальдо\s+на\s+/i.test(t) ||
        /^Обороты\s+за\s+период$/i.test(t) ||
        /^Карточка\s+счета/i.test(t)
    ) {
        return 'skip';
    }
    if (/^(ОАО|ООО|АО|ПАО|ЗАО)\s/i.test(t)) return 'entity';
    if (/^08(\.|$)/.test(t) || /^\d{2}(\.\d+)*(,\s|\s|,)/.test(t) || /^\d{2}(\.\d+)+$/.test(t)) {
        return 'account';
    }
    if (/^ОП\s/i.test(t)) return 'subdivision';
    if (/^Подразделение\s/i.test(t)) return 'subdivision';
    if (/^Контрагент/i.test(t)) return 'counterparty';
    if (/^Договор\s/i.test(t)) return 'contract';
    if (/Обороты\s+за\s+\d{4}/i.test(t)) return 'period';
    return 'other';
}

function createOsvContext(data) {
    const ctx = {
        entity: '',
        account: '',
        subdivision: '',
        counterparty: '',
        contract: '',
        pendingObject: '',
    };
    for (const row of data.slice(0, 12)) {
        const t = cellText(row, 0);
        if (/^(ОАО|ООО|АО|ПАО|ЗАО)\s/i.test(t)) ctx.entity = t;
    }
    return ctx;
}

function buildOsvRow(ctx, row, { objectName = '', period = '', year = '' } = {}) {
    const account = ctx.account;
    return {
        Юрлицо: ctx.entity,
        'Счёт, наименование счета': account,
        Счёт: account,
        Подразделение: ctx.subdivision,
        Контрагент: ctx.counterparty,
        Договор: ctx.contract,
        Объект: objectName,
        Период: period,
        Год: year,
        'Сальдо Дт начало': toNum(row[1]),
        'Сальдо Кт начало': toNum(row[2]),
        'Оборот Дт': toNum(row[3]),
        'Оборот Кт': toNum(row[4]),
        'Сальдо Дт конец': toNum(row[5]),
        'Сальдо Кт конец': toNum(row[6]),
    };
}

/** Карточка счёта 76 (договоры) vs ОСВ 08 (объекты ОС). */
function detectOsvProfile(data) {
    let hasContract = false;
    let hasCounterparty = false;
    let has08 = false;
    for (const row of data) {
        const label = cellText(row, 0);
        if (/^Договор\s/i.test(label)) hasContract = true;
        if (/^Контрагент/i.test(label)) hasCounterparty = true;
        if (/^08(\.|$)/.test(label)) has08 = true;
    }
    if (hasContract && hasCounterparty) return 'account_card';
    if (has08) return 'os_08';
    return 'generic';
}

/**
 * Раскладка дерева ОСВ / карточки счёта: только листья с суммами, предки в отдельных колонках.
 * @param {Array<Array>} data
 */
const { walkLevelsStack } = require('./tree_walker');
const { applyTreeProfileToRule } = require('./tree_profiles');

/** @deprecated используй walkTree; оставлено для тестов и smart_parse_os */
function walkOsvHierarchy(data, profileKey = 'os_76_card') {
    const rule = applyTreeProfileToRule(
        {
            rule_schema_version: 2,
            meta: { name: 'osv', source_type: 'excel' },
            layout: { layout_type: 'hierarchy_osv', name_column: 0 },
            columns: [],
        },
        profileKey
    );
    const { rows, warnings } = walkLevelsStack(data, rule);
    return { rows, warnings };
}

module.exports = {
    classifyOsvLabel,
    walkOsvHierarchy,
    detectOsvProfile,
    hasOsvTurnover,
    toNum,
    cellText,
};
