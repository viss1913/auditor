/**
 * Классификация структуры листа Excel без имён файла/листа.
 * Сигналы: геометрия, типы ячеек, семантика col A.
 */
const {
    scanCol0,
    detectPeriodBandRow,
    detectWideYearHeaderRow,
    detectFlatDimensionHeaderRow,
    detectUkStructure,
    detectReportTitleKind,
    UK_DATE_RE,
    ACCOUNT_90_RE,
} = require('./layout_fingerprint');
const { detectUkOsv58Block } = require('./uk_osv_martin');

const MIN_AUTO_CONFIDENCE = 0.85;
const AMBIGUITY_GAP = 0.12;
const MIN_KNOWN_CONFIDENCE = 0.55;

const STRUCTURE_IDS = [
    'instruction',
    'workpaper',
    'uk_journal_58',
    'uk_osv_58',
    'journal_1c',
    'tree_account_76',
    'tree_os_08',
    'revenue_osv_90',
    'hierarchy_os_01',
    'flat_osv',
    'wide_years',
    'unknown',
];

/** structure_id → профиль оркестратора */
const STRUCTURE_TO_PROFILE = {
    uk_journal_58: 'uk_card',
    uk_osv_58: 'uk_osv_58',
    journal_1c: 'ks_card',
    tree_account_76: 'catalog_scenario',
    tree_os_08: 'catalog_scenario',
    revenue_osv_90: 'revenue_period',
    hierarchy_os_01: 'catalog_scenario',
    flat_osv: 'osv_flat_processed',
    wide_years: 'catalog_scenario',
};

function cellText(row, col) {
    return String((row && row[col]) ?? '').trim();
}

function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    if (!/^-?\d/.test(s)) return null;
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function rowHasNumbers(row, fromCol = 1) {
    for (let c = fromCol; c < (row || []).length; c++) {
        if (toNum(row[c]) != null) return true;
    }
    return false;
}

function isInstructionStructure(data) {
    const text = (data || [])
        .slice(0, 40)
        .map((r) => (r || []).join(' '))
        .join(' ')
        .slice(0, 1200);
    if (!/при выгрузке|необходимо чтобы|рассмотрим \d+ сч/i.test(text)) return false;

    const journal = detectJournalStructure(data);
    const col0 = scanCol0(data);
    if (journal.score >= 0.7) return false;
    if (col0.contractLabels > 1 && col0.counterpartyLabels > 0) return false;
    if (col0.account08 > 0 || col0.osInventoryLike > 0) return false;
    return true;
}

function isWorkpaperStructure(data) {
    const text = (data || [])
        .slice(0, 30)
        .map((r) => (r || []).join(' '))
        .join(' ')
        .slice(0, 1200);
    return /процедуры/i.test(text) && /ссылки/i.test(text) && /вывод/i.test(text);
}

/**
 * Журнал 1С: шапка + col0 = даты, справа Дт/Кт блок; нет дерева Договор/Контрагент.
 */
function countJournalDateRows(data, fromRow, limit = 120) {
    let dateRows = 0;
    const scanEnd = Math.min(data.length, fromRow + limit);
    for (let i = fromRow; i < scanEnd; i++) {
        if (UK_DATE_RE.test(cellText(data[i], 0)) && rowHasNumbers(data[i], 2)) dateRows++;
    }
    return dateRows;
}

function findJournalHeaderRow(data) {
    let best = { headerRow: -1, dataStartRow: -1, dateRows: 0 };

    for (let i = 0; i < Math.min(35, data.length - 4); i++) {
        const dateRows = countJournalDateRows(data, i + 1, 100);
        if (dateRows < 3) continue;

        let headerRow = i;
        const row = data[i] || [];
        const textCells = row.filter((c) => {
            const t = String(c || '').trim();
            return t && toNum(c) == null && !UK_DATE_RE.test(t);
        }).length;
        if (textCells < 2 && i > 0) headerRow = Math.max(0, i - 1);

        if (dateRows > best.dateRows) {
            best = { headerRow, dataStartRow: i + 1, dateRows };
        }
    }
    return best;
}

function hasJournalHeaderLabels(data, headerRow) {
    if (headerRow < 0) return false;
    const chunks = [];
    for (let r = Math.max(0, headerRow - 1); r <= headerRow + 1 && r < data.length; r++) {
        chunks.push(...(data[r] || []).map((c) => String(c || '').toLowerCase()));
    }
    const text = chunks.join(' ');
    return /период/.test(text) && /(дебет|кредит)/.test(text);
}

function isStrongJournal(journal) {
    return (
        journal?.score >= 0.88 &&
        journal.debitCreditCols &&
        journal.dateRows >= 10
    );
}

function detectJournalStructure(data) {
    const col0 = scanCol0(data);
    const hasTree76 =
        col0.contractLabels > 0 && col0.counterpartyLabels > 0 && (col0.account76 > 0 || col0.accountOther > 0);
    if (hasTree76) {
        return { score: 0, headerRow: -1, dateRows: 0, reason: 'tree76_labels' };
    }

    const found = findJournalHeaderRow(data);
    if (found.headerRow < 0 || found.dateRows < 3) {
        return { score: 0, headerRow: -1, dateRows: 0, reason: 'no_journal_dates' };
    }

    const debitCreditCols = hasDebitCreditGeometry(data, found.headerRow);
    let score = 0.74;
    if (found.dateRows >= 5) score += 0.08;
    if (found.dateRows >= 20) score += 0.06;
    if (debitCreditCols) score += 0.14;
    if (hasJournalHeaderLabels(data, found.headerRow)) score += 0.04;
    score = Math.min(0.98, score);

    if (!debitCreditCols) score = Math.min(score, 0.78);

    return {
        headerRow: found.headerRow,
        dataStartRow: found.dataStartRow,
        dateRows: found.dateRows,
        debitCreditCols,
        score,
        reason: `headerRow=${found.headerRow} dates=${found.dateRows} dtKt=${debitCreditCols}`,
    };
}

/** Две группы числовых колонок справа (счёт+сумма) без привязки к словам Дебет/Кредит. */
function hasDebitCreditGeometry(data, headerRow) {
    const subRow = data[headerRow + 1] || [];
    const hasLabeledDtKt =
        (data[headerRow] || []).some((c) => /дебет|кредит/i.test(String(c || ''))) ||
        subRow.some((c) => /счет|счёт|сумма/i.test(String(c || '')));
    if (hasLabeledDtKt) return true;

    const start = headerRow + 2;
    const numericCols = new Map();
    for (let i = start; i < Math.min(data.length, start + 40); i++) {
        const row = data[i] || [];
        if (!UK_DATE_RE.test(cellText(row, 0))) continue;
        for (let c = 2; c < row.length; c++) {
            if (toNum(row[c]) != null) numericCols.set(c, (numericCols.get(c) || 0) + 1);
        }
    }
    const hot = [...numericCols.entries()]
        .filter(([, n]) => n >= 2)
        .map(([c]) => c)
        .sort((a, b) => a - b);
    if (hot.length < 2) return false;

    const clusters = [];
    let cluster = [hot[0]];
    for (let i = 1; i < hot.length; i++) {
        if (hot[i] - hot[i - 1] <= 2) cluster.push(hot[i]);
        else {
            clusters.push(cluster);
            cluster = [hot[i]];
        }
    }
    clusters.push(cluster);
    return clusters.length >= 2 && clusters.some((cl) => cl.length >= 1);
}

function detectUkJournalStructure(data, journal) {
    const uk = detectUkStructure(data);
    if (!journal?.score || journal.score < 0.7) {
        return { score: uk.score >= 0.88 ? uk.score * 0.85 : 0, reason: `uk_only bu58=${uk.bu58}` };
    }
    if (uk.structureMatch || (uk.bu58 >= 2 && uk.dateRows >= 3)) {
        const journalScore = journal.score || 0.9;
        let headerBoost = 0;
        for (let i = 0; i < Math.min((data || []).length, 12); i++) {
            const text = (data[i] || []).join(' ');
            if (/текущее\s*сальдо/i.test(text) && /показатель/i.test(text)) {
                headerBoost = 0.02;
                break;
            }
        }
        // Паттерн БУ/58.01/Кол. важнее «голого» journal_1c (headerRow+dtKt).
        const score = uk.structureMatch
            ? Math.min(0.99, Math.max(journalScore + 0.05, 0.93) + headerBoost)
            : Math.min(0.97, Math.max(journalScore, 0.9) + headerBoost);
        return {
            score,
            reason: `journal+uk bu58=${uk.bu58} dates=${uk.dateRows}${headerBoost ? ' balance_hdr' : ''}`,
        };
    }
    if (uk.bu58 >= 1 && journal.dateRows >= 3) {
        return { score: 0.86, reason: `journal+uk_weak bu58=${uk.bu58}` };
    }
    return { score: 0, reason: 'no_uk_pattern' };
}

function detectTreeAccount76(data, options = {}, journal = null) {
    if (journal?.score >= 0.85 && journal.debitCreditCols && journal.dateRows >= 5) {
        return { score: 0, reason: 'journal_wins' };
    }
    const col0 = scanCol0(data);
    const has76Tree =
        col0.contractLabels > 0 &&
        col0.counterpartyLabels > 0 &&
        (col0.account76 > 0 || col0.accountOther > 0);
    if (!has76Tree) return { score: 0, reason: 'no_76_tree' };

    let score = 0.9;
    if (col0.contractLabels >= 5 && col0.counterpartyLabels >= 3) score = 0.96;
    if (options.hasOutline) score = Math.min(0.98, score + 0.03);
    return {
        score,
        reason: `contract=${col0.contractLabels} counterparty=${col0.counterpartyLabels} acc76=${col0.account76}`,
    };
}

function detectTreeOs08(data, options = {}, journal = null) {
    if (journal?.score >= 0.85 && journal.debitCreditCols && journal.dateRows >= 5) {
        return { score: 0, reason: 'journal_wins' };
    }
    const titleKind = detectReportTitleKind(data);
    if (titleKind === 'os_01') return { score: 0, reason: 'os01_title' };
    const col0 = scanCol0(data);
    const has76 =
        col0.contractLabels > 0 && col0.counterpartyLabels > 0 && col0.account76 > 0;
    if (has76 || col0.account08 === 0) {
        if (titleKind === 'osv_08') {
            let score = 0.88;
            if (options.hasOutline) score += 0.04;
            return { score: Math.min(0.95, score), reason: 'osv08_title' };
        }
        return { score: 0, reason: 'no_08' };
    }
    let score = 0.86;
    if (options.hasOutline) score += 0.04;
    if (titleKind === 'osv_08') score += 0.04;
    return { score: Math.min(0.95, score), reason: `account08=${col0.account08}` };
}

function detectUkOsv58Structure(data, journal) {
    if (journal?.score >= 0.85) return { score: 0, reason: 'journal_wins' };

    const block = detectUkOsv58Block(data);
    if (!block?.header) return { score: 0, reason: block?.titleHint ? 'no_header' : 'no_uk_osv' };
    if (block.buKolRows < 4) return { score: 0, reason: `buKol=${block.buKolRows}` };

    let score = 0.92;
    if (block.titleHint) score = 0.96;
    if (block.acc58Rows >= 1) score = Math.min(0.98, score + 0.02);
    return {
        score,
        reason: `title58=${block.titleHint} buKol=${block.buKolRows} acc58=${block.acc58Rows}`,
    };
}

function isUkOsv58Layout(data) {
    const block = detectUkOsv58Block(data);
    return Boolean(block?.header && block.buKolRows >= 4);
}

function detectRevenueStructure(data, journal) {
    const col0 = scanCol0(data);
    const periodBandRow = detectPeriodBandRow(data);
    if (journal?.score >= 0.85) return { score: 0, reason: 'journal_wins' };

    const revenueStruct =
        periodBandRow >= 0 && col0.account90 > 0 && col0.osInventoryLike === 0 && col0.contractLabels === 0;
    if (!revenueStruct) return { score: 0, reason: 'no_revenue_struct' };

    const titleHint = data
        .slice(0, 20)
        .some((row) => /оборотно-сальдовая\s+ведомость\s+по\s+счету\s+9/i.test((row || []).join(' ')));
    let score = 0.9;
    if (titleHint) score = 0.94;
    return { score, reason: `account90=${col0.account90} periodBand=${periodBandRow}` };
}

function detectHierarchyOs01(data, journal, options = {}) {
    if (journal?.score >= 0.85) return { score: 0, reason: 'journal_wins' };
    if (isUkOsv58Layout(data)) return { score: 0, reason: 'uk_osv_wins' };

    const titleKind = detectReportTitleKind(data);
    const col0 = scanCol0(data);
    const has76Tree =
        col0.contractLabels > 0 &&
        col0.counterpartyLabels > 0 &&
        (col0.account76 > 0 || col0.accountOther > 0);
    if (has76Tree && col0.contractLabels >= 3) return { score: 0, reason: 'tree76_wins' };
    const periodBandRow = detectPeriodBandRow(data);
    const hierarchyLike = data.slice(0, 40).filter((r) => cellText(r, 0) && rowHasNumbers(r, 1)).length;

    const revenueStruct =
        periodBandRow >= 0 && col0.account90 > 0 && col0.osInventoryLike === 0 && col0.contractLabels === 0;
    if (revenueStruct) return { score: 0, reason: 'revenue_wins' };

    const os01Struct =
        periodBandRow >= 0 &&
        (col0.osInventoryLike > 0 || col0.longTextWithNumbers >= 2 || options.hasOutline || hierarchyLike >= 5);
    if (!os01Struct) return { score: 0, reason: 'no_os01' };

    let score = options.hasOutline || col0.osInventoryLike > 0 ? 0.9 : 0.76;
    if (titleKind === 'os_01') score = Math.min(0.96, score + 0.05);
    return {
        score,
        reason: `inventory=${col0.osInventoryLike} outline=${options.hasOutline} hierarchy=${hierarchyLike} title=${titleKind || '—'}`,
    };
}

function detectFlatOsvStructure(data) {
    if (isUkOsv58Layout(data)) return { score: 0, reason: 'uk_osv_wins' };

    const flatDim = detectFlatDimensionHeaderRow(data);
    const col0 = scanCol0(data);
    const has76Tree =
        col0.contractLabels > 0 && col0.counterpartyLabels > 0 && col0.account76 > 0;
    const journal = detectJournalStructure(data);
    if (!flatDim || flatDim.dimCols < 4 || has76Tree) {
        return { score: 0, reason: 'no_flat' };
    }
    if (journal.score >= 0.8 && col0.dateRows >= 10) {
        return { score: 0, reason: 'journal_dates_dominate' };
    }
    let score = 0.84;
    if (col0.dateRows < 2 && flatDim.dimCols >= 5) score = 0.88;
    return { score, reason: `flatHeader=${flatDim.headerRow} dims=${flatDim.dimCols}` };
}

function detectWideYearsStructure(data) {
    const wideYearRow = detectWideYearHeaderRow(data);
    if (wideYearRow < 0) return { score: 0, reason: 'no_wide' };
    return { score: 0.86, reason: `wideHeaderRow=${wideYearRow}` };
}

function scoreAllStructures(data, options = {}) {
    const journal = detectJournalStructure(data);
    const candidates = [];

    if (isWorkpaperStructure(data)) {
        candidates.push({ structure_id: 'workpaper', confidence: 0.99, reason: 'workpaper_text' });
    }
    if (isInstructionStructure(data) && !candidates.some((c) => c.structure_id === 'workpaper')) {
        candidates.push({ structure_id: 'instruction', confidence: 0.95, reason: 'instruction_text' });
    }

    const push = (structure_id, det) => {
        if (!det?.score || det.score < MIN_KNOWN_CONFIDENCE) return;
        candidates.push({
            structure_id,
            confidence: det.score,
            reason: det.reason || structure_id,
        });
    };

    push('uk_journal_58', detectUkJournalStructure(data, journal));
    push('uk_osv_58', detectUkOsv58Structure(data, journal));
    push('journal_1c', journal.score >= MIN_KNOWN_CONFIDENCE ? journal : null);
    push('tree_account_76', detectTreeAccount76(data, options, journal));
    push('tree_os_08', detectTreeOs08(data, options, journal));
    push('revenue_osv_90', detectRevenueStructure(data, journal));
    push('hierarchy_os_01', detectHierarchyOs01(data, journal, options));
    push('flat_osv', detectFlatOsvStructure(data));
    push('wide_years', detectWideYearsStructure(data));

    candidates.sort((a, b) => b.confidence - a.confidence);

    if (!candidates.length) {
        return [
            {
                structure_id: 'unknown',
                confidence: 0,
                reason: 'no_structure_match',
            },
        ];
    }

    return candidates;
}

/**
 * @param {Array<Array>} data
 * @param {{ rowOutlineLevels?: number[], hasOutline?: boolean, mergedRanges?: unknown[], layoutMeta?: object }} options
 */
function classifySheetStructure(data, options = {}) {
    const hasOutline =
        Boolean(options.hasOutline) ||
        (options.rowOutlineLevels || []).some((l) => (l || 0) > 0);

    const ranked = scoreAllStructures(data, { ...options, hasOutline });
    let structuralRanked = ranked.filter(
        (c) => c.structure_id !== 'instruction' && c.structure_id !== 'workpaper'
    );
    const { applyOntologyTieBreak } = require('./structure_ontology');
    structuralRanked = applyOntologyTieBreak(structuralRanked, data);
    const top = structuralRanked[0] || ranked[0];
    const second = structuralRanked[1];
    const gap = second ? top.confidence - second.confidence : top.confidence;

    const col0 = scanCol0(data);
    const journal = detectJournalStructure(data);

    const signals = {
        hasOutline,
        journalHeaderRow: journal.headerRow,
        dateCol0Ratio: col0.dateRows,
        contractLabels: col0.contractLabels,
        counterpartyLabels: col0.counterpartyLabels,
        account90: col0.account90,
        account76: col0.account76,
        account08: col0.account08,
        osInventoryLike: col0.osInventoryLike,
    };

    const journalVsFlat =
        top.structure_id === 'journal_1c' &&
        second?.structure_id === 'flat_osv' &&
        top.confidence >= 0.88 &&
        signals.dateCol0Ratio >= 10;

    const journalDominatesTree =
        top.structure_id === 'journal_1c' &&
        isStrongJournal(journal) &&
        second &&
        ['tree_os_08', 'tree_account_76', 'flat_osv', 'revenue_osv_90', 'hierarchy_os_01'].includes(
            second.structure_id
        );

    const ukJournalClear =
        top.structure_id === 'uk_journal_58' &&
        top.confidence >= 0.88 &&
        /journal\+uk|bu58=/i.test(top.reason || '') &&
        second &&
        ['tree_os_08', 'journal_1c', 'flat_osv'].includes(second.structure_id);

    const ambiguous = Boolean(
        !journalVsFlat &&
            !journalDominatesTree &&
            !ukJournalClear &&
            top.structure_id !== 'unknown' &&
            top.structure_id !== 'instruction' &&
            top.structure_id !== 'workpaper' &&
            second &&
            gap < AMBIGUITY_GAP &&
            second.confidence >= MIN_KNOWN_CONFIDENCE
    );

    const autoParse =
        !ambiguous &&
        top.confidence >= MIN_AUTO_CONFIDENCE &&
        !['unknown', 'instruction', 'workpaper'].includes(top.structure_id);

    return {
        structure_id: top.structure_id,
        confidence: top.confidence,
        alternatives: ranked.slice(1, 4).map((c) => ({
            structure_id: c.structure_id,
            confidence: c.confidence,
        })),
        signals,
        fingerprint_reason: top.reason,
        ranked,
        autoParse,
        ambiguous,
        profileId: STRUCTURE_TO_PROFILE[top.structure_id] || null,
        minAutoConfidence: MIN_AUTO_CONFIDENCE,
    };
}

function structureIdToScenarioId(structure) {
    const id = structure?.structure_id;
    if (id === 'tree_account_76') return 'os_76_account_card';
    if (id === 'tree_os_08') return 'os_08_osv';
    if (id === 'hierarchy_os_01') return 'os_01_hierarchy';
    if (id === 'wide_years') return 'os_01_flat';
    if (id === 'uk_journal_58') return 'uk_card';
    if (id === 'uk_osv_58') return 'uk_osv_58';
    return null;
}

module.exports = {
    STRUCTURE_IDS,
    STRUCTURE_TO_PROFILE,
    MIN_AUTO_CONFIDENCE,
    AMBIGUITY_GAP,
    MIN_KNOWN_CONFIDENCE,
    classifySheetStructure,
    detectJournalStructure,
    findJournalHeaderRow,
    hasDebitCreditGeometry,
    structureIdToScenarioId,
    scoreAllStructures,
};
