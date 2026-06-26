/**
 * Отчёт валидации: structure/probe (ожидание) ↔ parse preview (факт).
 * Политика: warn и fail ломают ok — snapshot не принимается.
 */
const { UK_DATE_RE } = require('./layout_fingerprint');
const { structureIdToScenarioId } = require('./structure_classifier');
const { comparePreviewToTarget } = require('./compare_target');

const MIN_ROW_COUNT = 3;
const MIN_PROBE_DATES = 5;
const TARGET_MATCH_RATIO = 0.5;

const OS01_GARBAGE_HEADERS = /^(год|тип|остаточн|амортизац|начислен)/i;
const JOURNAL_HEADERS = /период|period|документ|document|аналитика|дебет|кредит|сальдо|счёт\s*дт|счёт\s*кт/i;

/** structure_id → допустимые scenarioId (если не указано — только structureIdToScenarioId) */
const ALLOWED_SCENARIOS = {
    journal_1c: ['ks_card_composite_raw', 'ks_card', 'ks_card_flat', 'uk_card'],
    uk_journal_58: ['uk_card', 'ks_card_composite_raw', 'ks_card'],
    uk_osv_58: ['uk_osv_58'],
    tree_account_76: ['os_76_account_card'],
    tree_os_08: ['os_08_osv'],
    hierarchy_os_01: ['os_01_hierarchy', 'os_01_flat'],
    revenue_osv_90: ['revenue_osv_90', 'revenue_period', 'revenue_osv'],
    flat_osv: ['osv_flat_processed', 'osv_flat'],
    wide_years: ['os_01_flat', 'wide_years'],
};

function makeCheck(id, title, status, expected, actual, detail = '') {
    return { id, title, status, expected, actual, detail };
}

function worstStatus(checks) {
    if (checks.some((c) => c.status === 'fail')) return 'fail';
    if (checks.some((c) => c.status === 'warn')) return 'warn';
    return 'pass';
}

function buildSummary(structureId, rowCount, checks) {
    const failed = checks.filter((c) => c.status !== 'pass');
    if (!failed.length) {
        return `Структура ${structureId || '?'} совпадает с preview (${rowCount} строк)`;
    }
    const names = failed.map((c) => c.id).join(', ');
    return `Валидация не пройдена: ${names}`;
}

function previewHeaders(preview) {
    return (preview?.headers || []).map((h) => String(h).toLowerCase());
}

function headerText(preview) {
    return previewHeaders(preview).join(' ');
}

function firstSample(preview) {
    return (preview?.rows || [])[0] || {};
}

function firstRowWithField(preview, fields = []) {
    for (const row of preview?.rows || []) {
        for (const f of fields) {
            if (String(row?.[f] ?? '').trim()) return row;
        }
    }
    return firstSample(preview);
}

function checkRowCount(preview) {
    const count = preview?.rowCount ?? preview?.rows?.length ?? 0;
    if (preview?.ok === false || count === 0) {
        return makeCheck('row_count', 'Количество строк', 'fail', '>= 1', String(count));
    }
    if (count < MIN_ROW_COUNT) {
        return makeCheck(
            'row_count',
            'Количество строк',
            'warn',
            `>= ${MIN_ROW_COUNT}`,
            String(count),
            'Мало строк для уверенной валидации'
        );
    }
    return makeCheck('row_count', 'Количество строк', 'pass', `>= ${MIN_ROW_COUNT}`, String(count));
}

function checkScenarioAlignment(structure, scenarioId) {
    const structureId = structure?.structure_id;
    if (!structureId || !scenarioId) {
        return makeCheck('scenario_alignment', 'Сценарий vs структура', 'pass', '—', scenarioId || '—');
    }

    const primary = structureIdToScenarioId(structure);
    const allowed = ALLOWED_SCENARIOS[structureId] || (primary ? [primary] : []);

    if (!allowed.length) {
        return makeCheck('scenario_alignment', 'Сценарий vs структура', 'pass', structureId, scenarioId);
    }

    const ok = allowed.includes(scenarioId);
    return makeCheck(
        'scenario_alignment',
        'Сценарий vs структура',
        ok ? 'pass' : 'fail',
        allowed.join(' | '),
        scenarioId
    );
}

function checkJournalHeaders(preview) {
    const headers = previewHeaders(preview);
    const text = headerText(preview);

    if (OS01_GARBAGE_HEADERS.test(headers[0] || '') && OS01_GARBAGE_HEADERS.test(headers[1] || '')) {
        return makeCheck(
            'journal_headers',
            'Заголовки журнала',
            'fail',
            'Период, Дт/Кт, Аналитика',
            (preview.headers || []).slice(0, 4).join(', ')
        );
    }
    if (!JOURNAL_HEADERS.test(text)) {
        return makeCheck(
            'journal_headers',
            'Заголовки журнала',
            'fail',
            'Период / Документ / Дт/Кт',
            (preview.headers || []).slice(0, 6).join(', ')
        );
    }
    return makeCheck(
        'journal_headers',
        'Заголовки журнала',
        'pass',
        'Период, Дт/Кт',
        (preview.headers || []).slice(0, 4).join(', ')
    );
}

function checkJournalProbeDates(structure, preview) {
    const signals = structure?.signals || {};
    const dateRatio = signals.dateCol0Ratio || 0;
    if (dateRatio < MIN_PROBE_DATES) {
        return makeCheck(
            'probe_dates',
            'Даты в col A (probe)',
            'pass',
            `probe < ${MIN_PROBE_DATES}`,
            `probe=${dateRatio}`
        );
    }

    const headers = previewHeaders(preview);
    const hasPeriodCol = headers.some((h) => /период|period/.test(h));
    const sample = firstSample(preview);
    const firstVal = String(
        sample['Период'] || sample.period || sample[preview.headers?.[0]] || Object.values(sample)[0] || ''
    ).trim();
    const hasDateSample = UK_DATE_RE.test(firstVal) || /^\d{2}\.\d{2}\.\d{4}$/.test(firstVal);

    const ok = hasPeriodCol || hasDateSample;
    return makeCheck(
        'probe_dates',
        'Даты в col A (probe)',
        ok ? 'pass' : 'warn',
        'Колонка Период или даты в sample',
        hasPeriodCol ? 'есть Период' : firstVal || '(пусто)'
    );
}

function checkJournalGarbageCol0(preview) {
    const headers = previewHeaders(preview);
    const bad = /^(год|тип|остаточн)/i.test(headers[0] || '');
    return makeCheck(
        'journal_no_os01',
        'Не ОС 01 в заголовках',
        bad ? 'fail' : 'pass',
        'не Год/Тип/Остаточная',
        preview.headers?.[0] || ''
    );
}

function checkTree76(preview, structure) {
    const checks = [];
    const text = headerText(preview);
    const headersOk = /счёт|контрагент|договор|account|contract/.test(text);
    checks.push(
        makeCheck(
            'tree76_headers',
            'Заголовки карточки 76',
            headersOk ? 'pass' : 'fail',
            'Счёт, Контрагент, Договор',
            (preview.headers || []).slice(0, 5).join(', ')
        )
    );

    const sample = firstRowWithField(preview, ['Контрагент', 'counterparty', 'Договор', 'contract']);
    const cp = String(sample['Контрагент'] || sample.counterparty || '').trim();
    checks.push(
        makeCheck(
            'tree76_counterparty',
            'Контрагент в sample',
            cp ? 'pass' : 'fail',
            'непустой Контрагент',
            cp || '(пусто)'
        )
    );

    const signals = structure?.signals || {};
    const probeTree =
        (signals.contractLabels || 0) > 0 && (signals.counterpartyLabels || 0) > 0;
    if (probeTree && !headersOk) {
        checks.push(
            makeCheck(
                'tree76_probe',
                'Probe дерево 76',
                'fail',
                'Договор+Контрагент в probe → headers 76',
                (preview.headers || []).slice(0, 3).join(', ')
            )
        );
    }

    return checks;
}

function checkHierarchyOs01(preview, scenarioId) {
    const checks = [];
    const headers = previewHeaders(preview);
    const headersOk = headers.includes('ос') || headers.includes('группа') || headers.includes('тип');
    checks.push(
        makeCheck(
            'os01_headers',
            'Колонки ОС/Группа',
            headersOk ? 'pass' : 'fail',
            'ОС или Группа',
            (preview.headers || []).slice(0, 5).join(', ')
        )
    );

    const sample = firstSample(preview);
    const osVal = String(sample['ОС'] || sample['ос'] || sample['Счёт'] || '').trim();
    let sampleOk = true;
    let actual = osVal || '(пусто)';
    if (UK_DATE_RE.test(osVal) || /^\d{2}\.\d{2}\.\d{4}$/.test(osVal)) {
        sampleOk = false;
        actual = `дата: ${osVal}`;
    } else if (/^9[01]\.\d+/.test(osVal) || /выруч|доход|реализац/i.test(osVal)) {
        sampleOk = false;
    } else if (String(sample['Группа'] || '').trim() === 'Период') {
        sampleOk = false;
        actual = 'Группа=Период';
    }

    if (scenarioId === 'os_01_hierarchy' || scenarioId === 'os_01_flat' || !scenarioId) {
        checks.push(
            makeCheck(
                'os01_sample',
                'Sample строка ОС',
                sampleOk ? 'pass' : 'fail',
                'не дата, не 90.xx',
                actual
            )
        );
    }

    return checks;
}

function checkFlatOsv(preview) {
    const text = headerText(preview);
    const dimOk = /счёт|подраздел|контрагент|договор|субконто/.test(text);
    const checks = [
        makeCheck(
            'flat_osv_headers',
            'Измерения ОСВ',
            dimOk ? 'pass' : 'fail',
            'Счёт + измерения',
            (preview.headers || []).slice(0, 6).join(', ')
        ),
    ];

    const sample = firstSample(preview);
    const firstKey = preview.headers?.[0];
    const firstVal = String(sample[firstKey] || '').trim();
    if (UK_DATE_RE.test(firstVal)) {
        checks.push(
            makeCheck(
                'flat_osv_not_journal',
                'Не журнал в flat ОСВ',
                'warn',
                'первая колонка не дата',
                firstVal
            )
        );
    }

    return checks;
}

function checkUkOsv58(preview) {
    const text = headerText(preview);
    const hasWideMeasures = /\/\s*БУ/i.test(text) && /\/\s*Кол/i.test(text);
    const has58 = /58|сальдо|оборот/i.test(text);
    const sample = firstSample(preview);

    return [
        makeCheck(
            'uk_osv_headers',
            'Заголовки ОСВ 58',
            hasWideMeasures && has58 ? 'pass' : 'warn',
            'период / Дт-Кт / БУ-Кол',
            (preview.headers || []).slice(0, 6).join(', ')
        ),
        makeCheck(
            'uk_osv_currency',
            'Колонка валюты',
            preview.headers?.includes('Валюта') ? 'pass' : 'warn',
            'Валюта',
            String(sample.Валюта ?? '—')
        ),
    ];
}

function checkRevenue(preview, structure) {
    const text = headerText(preview);
    const journalLike = JOURNAL_HEADERS.test(text) && /аналитика/.test(text);
    const signals = structure?.signals || {};
    const revenueProbe = (signals.account90 || 0) > 0;
    const revenueHeaders = /90|выруч|доход|реализац/i.test(text);

    const checks = [];
    checks.push(
        makeCheck(
            'revenue_not_journal',
            'Выручка ≠ журнал',
            journalLike ? 'fail' : 'pass',
            'не journal-аналитика',
            (preview.headers || []).slice(0, 4).join(', ')
        )
    );
    checks.push(
        makeCheck(
            'revenue_signals',
            'Признаки счёта 90',
            revenueProbe || revenueHeaders ? 'pass' : 'warn',
            '90 в probe или headers',
            revenueProbe ? `probe account90=${signals.account90}` : (preview.headers || []).slice(0, 3).join(', ')
        )
    );
    return checks;
}

function checkTreeOs08(preview, structure) {
    const signals = structure?.signals || {};
    const text = headerText(preview);
    const ok = (signals.account08 || 0) > 0 || /08\.|счёт\s*08|ос\s*08/i.test(text);
    return [
        makeCheck(
            'tree_os08',
            'Счёт 08',
            ok ? 'pass' : 'warn',
            '08 в probe или headers',
            (signals.account08 || 0) > 0 ? `probe=${signals.account08}` : (preview.headers || []).slice(0, 4).join(', ')
        ),
    ];
}

function checkUkCard(preview) {
    const headers = (preview.headers || []).map((h) => String(h).toLowerCase());
    const text = headerText(preview);
    const coreOk = ['period', 'document', 'amount', 'quantity', 'debit_account', 'credit_account'].every((h) =>
        headers.includes(h)
    );
    const balanceOk = headers.includes('current_balance_bu') && headers.includes('current_balance_qty');
    const rows = preview.rows || [];
    const hasBalanceData = rows.some(
        (r) => r.current_balance_bu != null || r.current_balance_qty != null
    );

    return [
        makeCheck(
            'uk_card_headers',
            'Заголовки УК',
            coreOk ? 'pass' : 'fail',
            'period/document/amount/quantity/debit/credit',
            (preview.headers || []).join(', ')
        ),
        makeCheck(
            'uk_card_balance_columns',
            'Сальдо БУ/Кол.',
            balanceOk ? 'pass' : hasBalanceData ? 'warn' : 'fail',
            'current_balance_bu + current_balance_qty',
            (preview.headers || []).filter((h) => /balance/i.test(h)).join(', ') || 'нет колонок сальдо'
        ),
    ];
}

function checkTargetCompare(preview, target) {
    if (!target?.rows?.length) return [];

    const cmp = comparePreviewToTarget(preview, target);
    const s = cmp.summary || {};
    const previewCount = s.previewCount || 0;
    const matched = s.matched || 0;
    const ratio = previewCount > 0 ? matched / previewCount : 0;

    const targetHeaders = target.headers || [];
    const previewHdrs = preview.headers || [];
    const overlap = targetHeaders.filter((h) => previewHdrs.includes(h));
    const colRatio = targetHeaders.length > 0 ? overlap.length / targetHeaders.length : 1;

    const checks = [
        makeCheck(
            'target_columns',
            'Колонки vs эталон',
            colRatio >= TARGET_MATCH_RATIO ? 'pass' : 'fail',
            `>= ${Math.round(TARGET_MATCH_RATIO * 100)}% совпадения`,
            `${overlap.length}/${targetHeaders.length}`
        ),
        makeCheck(
            'target_rows',
            'Строки vs эталон',
            ratio >= TARGET_MATCH_RATIO && (s.mismatchCount || 0) === 0 ? 'pass' : ratio >= TARGET_MATCH_RATIO ? 'warn' : 'fail',
            `matched >= ${Math.round(TARGET_MATCH_RATIO * 100)}%`,
            `matched=${matched}, mismatches=${s.mismatchCount || 0}, missing=${s.missingInTarget || 0}`
        ),
    ];

    return checks;
}

function structureSpecificChecks(structure, scenarioId, preview) {
    const structureId = structure?.structure_id;
    if (!structureId) return [];

    if (structureId === 'uk_journal_58') {
        if (scenarioId === 'uk_card') return checkUkCard(preview);
        return [
            checkJournalHeaders(preview),
            checkJournalGarbageCol0(preview),
            checkJournalProbeDates(structure, preview),
        ];
    }
    if (structureId === 'journal_1c') {
        return [
            checkJournalHeaders(preview),
            checkJournalGarbageCol0(preview),
            checkJournalProbeDates(structure, preview),
        ];
    }
    if (structureId === 'tree_account_76' || scenarioId === 'os_76_account_card') {
        return checkTree76(preview, structure);
    }
    if (structureId === 'hierarchy_os_01' || /^os_01/.test(scenarioId || '')) {
        return checkHierarchyOs01(preview, scenarioId);
    }
    if (structureId === 'flat_osv') {
        return checkFlatOsv(preview);
    }
    if (structureId === 'revenue_osv_90') {
        return checkRevenue(preview, structure);
    }
    if (structureId === 'uk_osv_58') {
        return checkUkOsv58(preview);
    }
    if (structureId === 'tree_os_08') {
        return checkTreeOs08(preview, structure);
    }
    if (scenarioId === 'uk_card') {
        return checkUkCard(preview);
    }

    return [];
}

/**
 * @param {{ structure?: object, scenarioId?: string, profileId?: string, preview?: object, target?: object }} params
 */
function buildParseValidationReport({ structure, scenarioId, profileId, preview, target }) {
    const checks = [];

    checks.push(checkRowCount(preview));
    checks.push(checkScenarioAlignment(structure, scenarioId));
    checks.push(...structureSpecificChecks(structure, scenarioId, preview));

    if (target?.rows?.length) {
        checks.push(...checkTargetCompare(preview, target));
    }

    const level = worstStatus(checks);
    const ok = level === 'pass';
    const rowCount = preview?.rowCount ?? preview?.rows?.length ?? 0;

    return {
        ok,
        level,
        checks,
        summary: buildSummary(structure?.structure_id, rowCount, checks),
        structureId: structure?.structure_id || null,
        scenarioId: scenarioId || null,
        profileId: profileId || null,
    };
}

/** Boolean wrapper для обратной совместимости */
function validationReportOk(params) {
    return buildParseValidationReport(params).ok;
}

module.exports = {
    MIN_ROW_COUNT,
    MIN_PROBE_DATES,
    TARGET_MATCH_RATIO,
    buildParseValidationReport,
    validationReportOk,
};
