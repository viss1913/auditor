/**
 * Структурная онтология листа Excel — форма таблицы, не имена колонок.
 */
const { scanCol0, detectUkStructure, UK_DATE_RE } = require('./layout_fingerprint');
const { detectUkOsv58Block } = require('./uk_osv_martin');
const { probeUkLayout } = require('./uk_layout_probe');

const STRUCTURE_TO_SCENARIO = {
    uk_journal_58: 'uk_card',
    uk_osv_58: 'uk_osv_58',
    journal_1c: 'ks_card_composite_raw',
    tree_account_76: 'os_76_account_card',
    tree_os_08: 'os_08_osv',
    hierarchy_os_01: 'os_01_hierarchy',
    revenue_osv_90: 'revenue_osv_90',
    flat_osv: 'osv_flat_processed',
    wide_years: 'wide_metrics',
};

function cellText(row, col) {
    return String((row && row[col]) ?? '').trim();
}

function detectRowPattern(data, uk, journal) {
    if (uk?.structureMatch || (uk?.bu58 >= 2 && uk?.kolRows >= 2)) {
        return 'bu_kol_pairs';
    }
    const osv58 = detectUkOsv58Block(data || []);
    if (osv58?.score >= 0.85) return 'wide_bu_kol_columns';
    if (journal?.debitCreditCols && journal?.dateRows >= 3) return 'journal_dt_kt';
    const col0 = scanCol0(data);
    if (col0.contractLabels > 0 && col0.counterpartyLabels > 0) return 'hierarchy_labels';
    const flatDim = (data || []).slice(0, 15).some((row) => {
        const text = (row || []).filter((c) => String(c || '').trim()).length;
        return text >= 4;
    });
    if (flatDim && col0.dateRows < 3) return 'flat_dimensions';
    return 'unknown';
}

function isUkCardLayout(ontology) {
    if (!ontology) return false;
    if (ontology.row_pattern !== 'bu_kol_pairs') return false;
    return (ontology.account_signals?.bu58 || 0) >= 2;
}

/**
 * Детерминированный выбор scenarioId по онтологии (приоритет над «голым» journal_1c).
 * @param {object} ontology
 * @returns {string|null}
 */
function resolveScenarioFromOntology(ontology) {
    if (!ontology) return null;
    if (isUkCardLayout(ontology)) return 'uk_card';
    if (ontology.row_pattern === 'wide_bu_kol_columns') return 'uk_osv_58';
    if (ontology.row_pattern === 'journal_dt_kt' && (ontology.account_signals?.bu58 || 0) < 2) {
        return 'ks_card_composite_raw';
    }
    return ontology.suggested_scenario || null;
}

function detectBalanceSignals(data, startRow, indicatorCol, balanceCol) {
    let hasHeader = false;
    for (let i = 0; i < Math.min(startRow, 12); i++) {
        const text = (data[i] || []).join(' ');
        if (/текущее\s*сальдо/i.test(text)) {
            hasHeader = true;
            break;
        }
    }
    let buBalanceRows = 0;
    let kolBalanceRows = 0;
    const scanEnd = Math.min((data || []).length, startRow + 250);
    for (let i = startRow; i < scanEnd; i++) {
        const row = data[i] || [];
        const indicator = cellText(row, indicatorCol);
        const raw = row[balanceCol];
        const num = parseFloat(
            String(raw ?? '')
                .replace(/^([ДКDK])\s*/i, '')
                .replace(/\s/g, '')
                .replace(',', '.')
        );
        if (!Number.isFinite(num)) continue;
        if (indicator === 'БУ') buBalanceRows++;
        if (indicator === 'Кол.') kolBalanceRows++;
    }
    return {
        has_header: hasHeader,
        balance_column: balanceCol,
        bu_balance_rows: buBalanceRows,
        kol_balance_rows: kolBalanceRows,
        has_balance_pairs: buBalanceRows + kolBalanceRows >= 2,
    };
}

function detectDateColumnRole(data) {
    let dateCol = -1;
    let maxDates = 0;
    const scanEnd = Math.min((data || []).length, 120);
    for (let c = 0; c < 4; c++) {
        let count = 0;
        for (let i = 0; i < scanEnd; i++) {
            if (UK_DATE_RE.test(cellText(data[i], c))) count++;
        }
        if (count > maxDates) {
            maxDates = count;
            dateCol = c;
        }
    }
    if (dateCol === 0 && maxDates >= 2) return { role: 'col_a', column: 0, date_rows: maxDates };
    if (dateCol >= 0 && maxDates >= 2) return { role: 'fixed_column', column: dateCol, date_rows: maxDates };
    return { role: null, column: dateCol, date_rows: maxDates };
}

function maxOutlineDepth(levels) {
    let max = 0;
    for (let i = 0; i < levels.length; i++) {
        const l = levels[i] || 0;
        if (l > max) max = l;
    }
    return max;
}

/**
 * @param {Array<Array>} data
 * @param {{ layoutMeta?: object, structure?: object, hasOutline?: boolean, rowOutlineLevels?: number[] }} options
 */
function buildStructureOntology(data, options = {}) {
    const layoutMeta = options.layoutMeta || {};
    const structure = options.structure || {};
    const hasOutline =
        Boolean(options.hasOutline) ||
        (options.rowOutlineLevels || []).some((l) => (l || 0) > 0);
    const outlineDepth = maxOutlineDepth(options.rowOutlineLevels || []);

    const col0 = scanCol0(data);
    const uk = detectUkStructure(data);
    const journal = options.journal || { headerRow: -1, dataStartRow: 0, dateRows: 0, debitCreditCols: false, score: 0 };
    const rowPattern = detectRowPattern(data, uk, journal);

    const layoutType =
        layoutMeta.recommended?.layout_type ||
        layoutMeta.column_catalog?.layout_type ||
        (rowPattern === 'wide_bu_kol_columns' ? 'hierarchy_rows' : null) ||
        (rowPattern === 'bu_kol_pairs' || rowPattern === 'journal_dt_kt' ? 'fixed_columns' : null) ||
        (rowPattern === 'hierarchy_labels' ? 'hierarchy_osv' : 'unknown');

    const dataStartRow =
        layoutMeta.uk_probe?.skip_rows ??
        layoutMeta.column_catalog?.data_start_row ??
        journal.headerRow >= 0
            ? journal.dataStartRow
            : 7;

    let ukProbe = layoutMeta.uk_probe || null;
    if (!ukProbe && (rowPattern === 'bu_kol_pairs' || uk.bu58 >= 1)) {
        ukProbe = probeUkLayout(data, { data_start_row: dataStartRow });
    }

    const balanceSignals =
        ukProbe?.balance_column != null
            ? detectBalanceSignals(
                  data,
                  dataStartRow,
                  ukProbe.indicator_column ?? 5,
                  ukProbe.balance_column
              )
            : { has_header: false, has_balance_pairs: false, balance_column: null };

    const classifierRanked = (options.ranked || structure.ranked || [])
        .filter((c) => !['instruction', 'workpaper'].includes(c.structure_id))
        .slice(0, 4)
        .map((c) => ({
            structure_id: c.structure_id,
            confidence: c.confidence,
            reason: c.reason,
        }));

    const suggestedScenario =
        rowPattern === 'bu_kol_pairs' && uk.bu58 >= 2
            ? 'uk_card'
            : rowPattern === 'wide_bu_kol_columns'
              ? 'uk_osv_58'
              : STRUCTURE_TO_SCENARIO[structure.structure_id] || null;

    return {
        layout_type: layoutType,
        has_tree: hasOutline,
        outline_depth: outlineDepth,
        row_pattern: rowPattern,
        merge_bu_kol: rowPattern === 'bu_kol_pairs',
        date_column: detectDateColumnRole(data),
        account_signals: {
            bu58: uk.bu58,
            kol_rows: uk.kolRows,
            date_rows: uk.dateRows,
            account76: col0.account76,
            account08: col0.account08,
            account90: col0.account90,
            contract_labels: col0.contractLabels,
            counterparty_labels: col0.counterpartyLabels,
        },
        journal_signals: {
            header_row: journal.headerRow,
            date_rows: journal.dateRows,
            debit_credit_cols: journal.debitCreditCols,
            score: journal.score,
        },
        classifier_ranked: classifierRanked,
        uk_probe: ukProbe,
        balance_signals: balanceSignals,
        parser_rule: isUkCardLayout({
            row_pattern: rowPattern,
            account_signals: { bu58: uk.bu58, kol_rows: uk.kolRows },
        })
            ? {
                  scenarioId: 'uk_card',
                  structure_id: 'uk_journal_58',
                  reason: `bu_kol_pairs bu58=${uk.bu58} kol=${uk.kolRows}`,
              }
            : null,
        suggested_scenario: suggestedScenario,
        suggested_structure_id:
            rowPattern === 'bu_kol_pairs' && uk.bu58 >= 2
                ? 'uk_journal_58'
                : structure.structure_id || classifierRanked[0]?.structure_id || null,
    };
}

/**
 * Tie-break: UK 58 card wins over generic journal when BU/Кол pairs present.
 * @param {Array<{ structure_id: string, confidence: number, reason?: string }>} ranked
 * @param {Array<Array>} data
 */
function applyOntologyTieBreak(ranked, data) {
    if (!ranked?.length) return ranked;
    const uk = detectUkStructure(data);
    if (!uk.structureMatch && uk.bu58 < 2) return ranked;

    const jIdx = ranked.findIndex((c) => c.structure_id === 'journal_1c');
    const uIdx = ranked.findIndex((c) => c.structure_id === 'uk_journal_58');
    if (jIdx < 0 && uIdx < 0) return ranked;

    const journal = jIdx >= 0 ? ranked[jIdx] : null;
    const ukCand =
        uIdx >= 0
            ? ranked[uIdx]
            : {
                  structure_id: 'uk_journal_58',
                  confidence: 0.93,
                  reason: `journal+uk bu58=${uk.bu58} dates=${uk.dateRows}`,
              };

    const boosted = {
        ...ukCand,
        confidence: Math.min(
            0.99,
            Math.max(ukCand.confidence, journal?.confidence || 0, 0.93) + 0.02
        ),
        reason: ukCand.reason || `journal+uk bu58=${uk.bu58} dates=${uk.dateRows}`,
    };

    const rest = ranked.filter(
        (c) => c.structure_id !== 'uk_journal_58' && c.structure_id !== 'journal_1c'
    );
    const journalEntry = journal || {
        structure_id: 'journal_1c',
        confidence: journal?.confidence || 0.78,
        reason: journal?.reason,
    };

    return [boosted, journalEntry, ...rest].sort((a, b) => b.confidence - a.confidence);
}

module.exports = {
    STRUCTURE_TO_SCENARIO,
    buildStructureOntology,
    applyOntologyTieBreak,
    detectRowPattern,
    isUkCardLayout,
    resolveScenarioFromOntology,
    detectBalanceSignals,
};
