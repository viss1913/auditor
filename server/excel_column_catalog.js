const { METRIC_FIELDS_01 } = require('./smart_parse_os');
const { walkHierarchy } = require('./hierarchy_walker');
const { walkTree } = require('./tree_walker');
const { applyTreeProfileToRule } = require('./tree_profiles');
const { readSheetWithMeta } = require('./excel_sheet_meta');

const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function colLetter(index) {
    if (index < 26) return COL_LETTERS[index];
    return COL_LETTERS[Math.floor(index / 26) - 1] + COL_LETTERS[index % 26];
}

function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

function rowHasNumbers(row, fromCol = 1) {
    for (let c = fromCol; c < row.length; c++) {
        const v = row[c];
        if (typeof v === 'number' && v !== 0) return true;
        const s = String(v || '').replace(/\s/g, '').replace(',', '.');
        if (/^-?\d/.test(s)) return true;
    }
    return false;
}

function loadSheetData(buffer, sheetName, options = {}) {
    const loaded = readSheetWithMeta(buffer, sheetName, options);
    return {
        data: loaded.data,
        sheetNames: loaded.sheetNames,
        sheetName: loaded.sheetName,
        rowOutlineLevels: loaded.rowOutlineLevels,
        hasOutline: loaded.hasOutline,
        styleHints: loaded.styleHints,
        skipRowIndices: loaded.skipRowIndices,
        hiddenRowIndices: loaded.hiddenRowIndices,
        excelProbe: loaded.excelProbe,
    };
}

/** Индекс col → ключ measure из METRIC_FIELDS_01 */
const COL_TO_MEASURE = Object.fromEntries(
    Object.entries(METRIC_FIELDS_01).map(([k, v]) => [String(v.col), k])
);

function matchMeasureFromHeader(headerPath, colIndex) {
    const text = headerPath.join(' ').toLowerCase();
    const isOpen = /начало|на\s+начало/i.test(text);
    const isClose = /конец|на\s+конец/i.test(text);
    const isResidual = /остаточн/i.test(text);
    const isCost = /стоимост/i.test(text) && !isResidual;
    const isAmort = /амортизац|износ/i.test(text) && !/списан/i.test(text) && !isResidual;

    if (isResidual && isOpen) return 'residual_open';
    if (isResidual && isClose) return 'residual_close';
    if (isCost && isOpen) return 'cost_open';
    if (isCost && isClose) return 'cost_close';
    if (isAmort && isOpen) return 'amort_open';
    if (isAmort && isClose) return 'amort_close';
    if (isAmort) return 'amort_charge';
    if (/увеличен/i.test(text)) return 'cost_increase';
    if (/уменьшен/i.test(text)) return 'cost_decrease';
    if (/списан/i.test(text)) return 'amort_writeoff';

    if (COL_TO_MEASURE[String(colIndex)]) {
        return COL_TO_MEASURE[String(colIndex)];
    }
    return null;
}

/** Строки-легенда дерева (не данные): «Контрагенты», «Договоры». */
function isOsvLegendRow(label) {
    const a = String(label || '').trim();
    return (
        /^Счет,?\s*Наименование|^Счёт,?\s*Наименование/i.test(a) ||
        /^Подразделение$/i.test(a) ||
        /^Контрагенты?$/i.test(a) ||
        /^Договоры?$/i.test(a)
    );
}

function skipOsvMetricHeaderRows(data, startRow) {
    let row = startRow;
    while (row < Math.min(data.length, startRow + 6)) {
        const line = (data[row] || []).map((c) => String(c || '')).join(' ');
        const a0 = cellText(data[row], 0);
        if (!a0 && /Дебет|Кредит/i.test(line)) {
            row++;
            continue;
        }
        if (/Сальдо\s+на\s+/i.test(line) || /Обороты\s+за\s+/i.test(line)) {
            row++;
            continue;
        }
        if (/^Дебет$/i.test(a0) || /^Кредит$/i.test(a0)) {
            row++;
            continue;
        }
        break;
    }
    return row;
}

/** Шапка карточки счёта / ОСВ: колонка A = уровни дерева (Счёт → Подразделение → …). */
function findOsvCardHeaderBlock(data) {
    for (let i = 0; i < Math.min(data.length, 35); i++) {
        const a = cellText(data[i], 0);
        if (!/^Счет,?\s*Наименование|^Счёт,?\s*Наименование/i.test(a)) continue;
        const sub = cellText(data[i + 1], 0);
        const ctr = cellText(data[i + 2], 0);
        const con = cellText(data[i + 3], 0);
        if (
            /^Подразделение$/i.test(sub) &&
            /^Контрагенты?$/i.test(ctr) &&
            /^Договоры?$/i.test(con)
        ) {
            const headerRows = [i, i + 1, i + 2, i + 3];
            const dataStartRow = skipOsvMetricHeaderRows(data, i + 4);
            return {
                headerRows,
                dataStartRow,
                hierarchyLegend: true,
            };
        }
    }

    let accountRow = -1;
    let subRow = -1;
    let counterRow = -1;
    let contractRow = -1;

    for (let i = 0; i < Math.min(data.length, 20); i++) {
        const a = cellText(data[i], 0);
        if (/^Счет,?\s*Наименование|^Счёт,?\s*Наименование/i.test(a)) accountRow = i;
        else if (/^Подразделение$/i.test(a)) subRow = i;
        else if (/^Контрагенты?$/i.test(a)) counterRow = i;
        else if (/^Договоры?$/i.test(a)) contractRow = i;
    }

    if (accountRow >= 0 && contractRow > accountRow) {
        const headerRows = [accountRow, subRow, counterRow, contractRow].filter((r) => r >= 0);
        const dataStartRow = skipOsvMetricHeaderRows(data, Math.max(...headerRows) + 1);
        return {
            headerRows,
            dataStartRow,
            hierarchyLegend: true,
        };
    }

    for (let i = 0; i < Math.min(data.length, 30); i++) {
        const line = data[i].map((c) => String(c || '')).join(' ');
        if (/Сальдо\s+на\s+начало/i.test(line) && /Обороты\s+за\s+период/i.test(line)) {
            const headerRows = [i];
            if (i + 1 < data.length && /Дебет|Кредит/i.test(data[i + 1].join(' '))) {
                headerRows.push(i + 1);
            }
            return {
                headerRows,
                dataStartRow: Math.max(...headerRows) + 1,
                hierarchyLegend: false,
            };
        }
    }

    return null;
}

function findHierarchyHeaderBlock(data) {
    let start = -1;
    for (let i = 0; i < Math.min(data.length, 20); i++) {
        const line = data[i].map((c) => String(c || '')).join(' ');
        if (/На начало периода|Группа учета/i.test(line)) {
            start = i;
            break;
        }
    }
    if (start < 0) return { headerRows: [], dataStartRow: 8 };

    const headerRows = [start];
    if (start + 1 < data.length && /Стоимость|Подразделение|Основное средство/i.test(cellText(data[start + 1], 0) + cellText(data[start + 1], 1))) {
        headerRows.push(start + 1);
    }
    if (start + 2 < data.length && /Основное средство|Инвентарный/i.test(data[start + 2].join(' '))) {
        headerRows.push(start + 2);
    }
    const dataStartRow = Math.max(...headerRows) + 1;
    return { headerRows, dataStartRow };
}

function buildPeriodBands(row5, maxCol) {
    const bands = [];
    let current = '';
    for (let c = 0; c <= maxCol; c++) {
        const t = cellText(row5, c);
        if (t) current = t;
        bands[c] = current;
    }
    return bands;
}

function buildHierarchyCatalog(data, layoutType) {
    const { headerRows, dataStartRow } = findHierarchyHeaderBlock(data);
    if (headerRows.length === 0) {
        return { name_column: { index: 0, letter: 'A' }, header_rows: [], metrics: [], data_start_row: 0 };
    }

    const maxCol = Math.max(...data.slice(0, 30).map((r) => r.length), 12);
    const periodBands = headerRows.length ? buildPeriodBands(data[headerRows[0]], maxCol) : [];

    const rowLabels = [];
    for (const hr of headerRows) {
        rowLabels[hr] = data[hr].map((c) => String(c || '').trim());
    }

    const metrics = [];
    for (let col = 1; col <= maxCol; col++) {
        const hasData = data.slice(dataStartRow, Math.min(data.length, dataStartRow + 40)).some((row) => {
            const n = row[col];
            if (typeof n === 'number' && n !== 0) return true;
            const s = String(n || '').replace(/\s/g, '');
            return /^-?\d/.test(s);
        });
        if (!hasData) continue;

        const header_path = [];
        if (periodBands[col]) header_path.push(periodBands[col]);
        for (const hr of headerRows.slice(1)) {
            const t = cellText(data[hr], col);
            if (t && !header_path.includes(t)) header_path.push(t);
        }
        if (header_path.length === 0) {
            const t = cellText(data[headerRows[0]], col);
            if (t) header_path.push(t);
        }

        const suggested_measure = matchMeasureFromHeader(header_path, col);
        const entry = {
            index: col,
            letter: colLetter(col),
            header_path,
        };
        if (suggested_measure) entry.suggested_measure = suggested_measure;
        metrics.push(entry);
    }

    const candidateIndexes = [0, 1, 2, 3].filter((i) => i < 4);
    const scores = {};
    const samples = {};

    function isNumericText(s) {
        const x = String(s || '').replace(/\s/g, '');
        return /^[\d.,+-]+$/.test(x) && x.length <= 30;
    }

    for (const c of candidateIndexes) {
        scores[c] = 0;
        samples[c] = '';
    }

    for (let i = dataStartRow; i < Math.min(data.length, dataStartRow + 35); i++) {
        for (const c of candidateIndexes) {
            const v = cellText(data[i], c);
            if (!v) continue;
            if (!samples[c] && v.length >= 6) samples[c] = v;
            if (v.length >= 12 && !isNumericText(v) && !/^Итого/i.test(v)) {
                scores[c]++;
            }
        }
    }

    const nameColumnCandidates = candidateIndexes
        .map((c) => ({
            index: c,
            letter: colLetter(c),
            score: scores[c] || 0,
            sample: samples[c] || '',
        }))
        .sort((a, b) => b.score - a.score);

    const nameCol = nameColumnCandidates[0]?.index ?? 0;

    return {
        layout_type: layoutType || 'hierarchy_rows',
        name_column: { index: nameCol, letter: colLetter(nameCol) },
        name_column_candidates: nameColumnCandidates.filter((c) => c.score > 0).slice(0, 4),
        header_rows: headerRows,
        data_start_row: dataStartRow,
        metrics,
    };
}

function buildOsvHierarchyCatalog(data, rowMeta = {}) {
    const osvHeader = findOsvCardHeaderBlock(data);
    const dataStartRow = osvHeader?.dataStartRow ?? 0;
    const headerRows = osvHeader?.headerRows ?? [];

    const metrics = [];
    const maxCol = Math.min(8, Math.max(...data.slice(0, 40).map((r) => r.length), 7));
    const metricDefs = [
        { col: 1, label: 'Сальдо Дт начало', measure: 'saldo_dt_open' },
        { col: 2, label: 'Сальдо Кт начало', measure: 'saldo_kt_open' },
        { col: 3, label: 'Оборот Дт', measure: 'turnover_dt' },
        { col: 4, label: 'Оборот Кт', measure: 'turnover_kt' },
        { col: 5, label: 'Сальдо Дт конец', measure: 'saldo_dt_close' },
        { col: 6, label: 'Сальдо Кт конец', measure: 'saldo_kt_close' },
    ];

    for (const m of metricDefs) {
        if (m.col > maxCol) continue;
        const hasData = data.slice(dataStartRow, Math.min(data.length, dataStartRow + 50)).some((row) => {
            const v = row[m.col];
            if (typeof v === 'number' && v !== 0) return true;
            const s = String(v || '').replace(/\s/g, '');
            return /^-?\d/.test(s);
        });
        if (!hasData) continue;
        metrics.push({
            index: m.col,
            letter: colLetter(m.col),
            header_path: [m.label],
            suggested_measure: m.measure,
        });
    }

    return {
        layout_type: 'hierarchy_osv',
        name_column: { index: 0, letter: 'A' },
        header_rows: headerRows,
        data_start_row: dataStartRow,
        hierarchy_legend: Boolean(osvHeader?.hierarchyLegend),
        metrics,
        row_outline_levels: rowMeta.rowOutlineLevels || [],
        has_row_outline: Boolean(rowMeta.hasOutline),
    };
}

function buildWideYearCatalog(data) {
    const metrics = [];
    let headerRow = -1;
    for (let i = 0; i < Math.min(data.length, 25); i++) {
        const labels = data[i].map((c) => String(c || '').trim());
        if (labels.some((l) => /^\d{4}\s*-\s*(начало|амортизация|конец)/i.test(l))) {
            headerRow = i;
            labels.forEach((label, col) => {
                const m = label.match(/^(\d{4})\s*-\s*(начало|амортизация|конец)/i);
                if (!m) return;
                const metricWord = m[2].toLowerCase();
                let suggested_measure = 'residual_open';
                if (metricWord === 'амортизация') suggested_measure = 'amort_charge';
                if (metricWord === 'конец') suggested_measure = 'residual_close';
                if (metricWord === 'начало') suggested_measure = 'residual_open';
                metrics.push({
                    index: col,
                    letter: colLetter(col),
                    header_path: [label],
                    year: m[1],
                    suggested_measure,
                });
            });
            break;
        }
    }
    return {
        layout_type: 'wide_metrics',
        name_column: { index: 0, letter: 'A' },
        header_rows: headerRow >= 0 ? [headerRow] : [],
        data_start_row: headerRow >= 0 ? headerRow + 1 : 0,
        metrics,
    };
}

function buildFixedColumnsCatalog(data) {
    let headerRow = 6;
    for (let i = 0; i < Math.min(12, data.length); i++) {
        if (/^\d{2}\.\d{2}\.\d{4}/.test(cellText(data[i], 0))) {
            headerRow = Math.max(0, i - 1);
            break;
        }
    }
    const headers = data[headerRow] || [];
    const columns = [];
    headers.forEach((h, index) => {
        const header = String(h || '').trim();
        if (!header) return;
        columns.push({ index, letter: colLetter(index), header, role: 'data_column' });
    });
    return {
        layout_type: 'fixed_columns',
        name_column: { index: 0, letter: 'A' },
        header_rows: [headerRow],
        data_start_row: headerRow + 1,
        metrics: [],
        fixed_columns: columns,
        uk_quantity_detect: (() => {
            const indicatorValue = 'Кол.';
            const scanStart = headerRow;
            const scanEnd = Math.min(data.length, headerRow + 200);

            // 1) Find indicator column: where "Кол." appears most
            const indicatorCounts = {};
            for (let i = scanStart; i < scanEnd; i++) {
                const row = data[i] || [];
                const limit = Math.min(row.length || 0, 12);
                for (let c = 0; c < limit; c++) {
                    const v = cellText(row, c);
                    if (v === indicatorValue) indicatorCounts[c] = (indicatorCounts[c] || 0) + 1;
                }
            }
            const rankedIndicators = Object.entries(indicatorCounts)
                .map(([idx, count]) => ({ index: Number(idx), count }))
                .sort((a, b) => b.count - a.count);
            const indicator_column = rankedIndicators[0]?.index;
            if (indicator_column == null) return null;

            // 2) Find quantity column: on "Кол." rows, which columns are mostly numeric
            function looksNumeric(val) {
                const s = String(val || '').replace(/\s/g, '').replace(',', '.');
                return /^-?\d+(\.\d+)?$/.test(s);
            }

            const qtyCounts = {};
            const qtySamples = {};
            const qtyCandidateCols = [];
            for (let c = 0; c <= 15; c++) qtyCandidateCols.push(c);

            for (let i = scanStart; i < scanEnd; i++) {
                const row = data[i] || [];
                if (cellText(row, indicator_column) !== indicatorValue) continue;

                for (const c of qtyCandidateCols) {
                    if (!row || c >= row.length) continue;
                    if (!looksNumeric(row[c])) continue;
                    qtyCounts[c] = (qtyCounts[c] || 0) + 1;
                    if (!qtySamples[c]) qtySamples[c] = String(row[c]);
                }
            }

            const rankedQty = Object.entries(qtyCounts)
                .map(([idx, count]) => ({
                    index: Number(idx),
                    count,
                    letter: colLetter(Number(idx)),
                    sample: qtySamples[idx] || '',
                }))
                .sort((a, b) => b.count - a.count);

            if (!rankedQty.length) return null;

            const top = rankedQty[0];
            const second = rankedQty[1];
            const ambiguous = Boolean(second) && top.count - second.count <= 2;

            return {
                indicator_column,
                suggested: top.index,
                ambiguous,
                options: rankedQty.slice(0, 3),
            };
        })(),
    };
}

function isLeafName(name, minLen = 18) {
    if (!name || name.length < minLen) return false;
    if (/^ОП\s|^РТК\s|^КЦ$|^Итого/i.test(name)) return false;
    return (
        /\d{2}\.\d{2}\.\d{4}/.test(name) ||
        /инв\.?|№\s*[\dA-Z-]|80-\d+|\d{6,}/i.test(name) ||
        /^ППА\s/i.test(name) ||
        name.length >= 25
    );
}

function extractHierarchyTreeSample(data, catalog, limit = 6) {
    const nameCol = catalog.name_column?.index ?? 0;
    const startRow = catalog.data_start_row ?? 0;

    if (catalog.layout_type === 'hierarchy_osv') {
        const draftRule = applyTreeProfileToRule(
            {
                rule_schema_version: 2,
                meta: { name: 'sample', source_type: 'excel' },
                layout: {
                    layout_type: 'hierarchy_osv',
                    name_column: nameCol,
                    data_start_row: startRow,
                },
                columns: [],
            },
            'os_76_card'
        );
        const { treeSample } = walkTree(data, draftRule, {
            treeSampleLimit: limit,
            rowOutlineLevels: catalog.row_outline_levels,
            styleHints: catalog.style_hints,
            skipRowIndices: catalog.style_hints?.likely_subtotal_rows,
            hiddenRowIndices: catalog.style_hints?.hidden_rows,
        });
        return (treeSample || []).map((r) => ({
            row_index: r.row_index,
            path: r.path,
            leaf_name: r.leaf_name,
        }));
    }

    const config = {
        layout: { name_column: nameCol, data_start_row: startRow },
        hierarchy: {
            leaf_rules: {
                min_name_length: 20,
                inventory_patterns: ['\\d{2}\\.\\d{2}\\.\\d{4}', 'инв\\.?', '№\\s*[\\dA-Z-]', '80-\\d+', '\\d{6,}'],
                skip_name_patterns: ['^ОП\\s', '^РТК\\s', '^КЦ$', '^Итого'],
            },
        },
        filters: { skip_row_patterns: ['^Итого'] },
    };
    const residualCol = (catalog.metrics || []).find((m) => m.suggested_measure === 'residual_close');
    const { rows } = walkHierarchy(data, config, { maxCol: 12, limit });
    return rows.map((r) => ({
        row_index: r.row_index,
        path: r.path,
        leaf_name: r.leaf_name,
        residual_close: residualCol ? r.row[residualCol.index] ?? null : null,
    }));
}

function extractSampleLeafRows(data, catalog, limit = 6) {
    const nameCol = catalog.name_column?.index ?? 0;
    const start = catalog.data_start_row ?? 8;
    const samples = [];

    for (let i = start; i < data.length && samples.length < limit; i++) {
        const row = data[i];
        const name = cellText(row, nameCol);
        if (!isLeafName(name)) continue;
        if (!rowHasNumbers(row, 1)) continue;

        const sample = { row_index: i, name };
        for (const m of catalog.metrics || []) {
            const key = m.suggested_measure || `col_${m.index}`;
            const val = row[m.index];
            sample[key] = val === '' || val === undefined ? null : val;
            sample[`${m.letter}_${m.header_path.join(' / ')}`] = sample[key];
        }
        samples.push(sample);
    }
    return samples;
}

function extractReportYear(data) {
    for (const row of data.slice(0, 10)) {
        const t = row.map((c) => String(c || '')).join(' ');
        const m = t.match(/за\s+.*?(\d{4})\s*г/i) || t.match(/(\d{4})\s*г/i);
        if (m) return m[1];
    }
    return null;
}

/**
 * @param {Buffer} buffer
 * @param {string} [sheetName]
 * @param {{ layout_type?: string }} [options]
 */
function buildColumnCatalog(buffer, sheetName, options = {}) {
    const preloaded = options.preloaded;
    const {
        data,
        sheetNames,
        sheetName: usedSheet,
        rowOutlineLevels,
        hasOutline,
        styleHints,
    } = preloaded
        ? {
              data: preloaded.data,
              sheetNames: preloaded.sheetNames,
              sheetName: preloaded.sheetName,
              rowOutlineLevels: preloaded.rowOutlineLevels ?? options.rowOutlineLevels ?? [],
              hasOutline: preloaded.hasOutline ?? options.hasOutline ?? false,
              styleHints: preloaded.styleHints ?? options.styleHints ?? null,
          }
        : loadSheetData(buffer, sheetName, {
              useExcelProbe: options.useExcelProbe,
              probe: options.probe,
              fileName: options.fileName,
          });

    const outlineLevels =
        options.rowOutlineLevels?.length ? options.rowOutlineLevels : rowOutlineLevels;
    const outlineFlag = options.hasOutline ?? hasOutline;
    const layoutType = options.layout_type;

    const hasPeriodBlock = data.some((row) =>
        /На начало периода/i.test(cellText(row, 1) + cellText(row, 2))
    );
    const hasWideYears = data.some((row, i) =>
        i < 25 && row.some((c) => /^\d{4}\s*-\s*(начало|амортизация|конец)/i.test(String(c || '')))
    );
    const hasUkDates = data.some((row) => /^\d{2}\.\d{2}\.\d{4}/.test(cellText(row, 0)));
    const has76Card =
        data.some((r) => /^Договор\s/i.test(cellText(r, 0))) &&
        data.some((r) => /^Контрагент/i.test(cellText(r, 0))) &&
        data.some((r) => /^\d{2}(\.\d+)*(,\s|\s|,)/.test(cellText(r, 0)));

    let catalog;
    if (layoutType === 'fixed_columns' || (!layoutType && hasUkDates && !hasPeriodBlock)) {
        catalog = buildFixedColumnsCatalog(data);
    } else if (layoutType === 'wide_metrics' || (!layoutType && hasWideYears && !hasPeriodBlock)) {
        catalog = buildWideYearCatalog(data);
    } else if (layoutType === 'hierarchy_osv' || has76Card) {
        catalog = buildOsvHierarchyCatalog(data, { rowOutlineLevels, hasOutline });
    } else {
        catalog = buildHierarchyCatalog(data, layoutType || 'hierarchy_rows');
    }

    catalog.sheet = usedSheet;
    catalog.style_hints = styleHints;
    catalog.report_year = extractReportYear(data);
    catalog.sample_leaf_rows = extractSampleLeafRows(data, catalog);
    catalog.hierarchy_tree_sample = extractHierarchyTreeSample(data, catalog);

    const previewStart = Math.max(0, (catalog.header_rows[0] || 0) - 1);
    const previewEnd = Math.min(data.length, (catalog.data_start_row || 15) + 5);
    catalog.preview_tsv = data
        .slice(previewStart, previewEnd)
        .map((row, idx) => {
            const absRow = previewStart + idx;
            return `R${absRow}\t${row.map((c, ci) => `${colLetter(ci)}:${c}`).join('\t')}`;
        })
        .join('\n');

    return { catalog, sheetNames, sheetName: usedSheet, rowCount: data.length };
}

/** Матчинг фраз аудитора на metrics из каталога */
function matchUserTextToMeasures(userText, catalog, yearFallback = '2024') {
    const t = String(userText || '').toLowerCase();
    const year = (t.match(/20\d{2}/) || [])[0] || catalog?.report_year || yearFallback;
    const selected = [];
    const metrics = catalog?.metrics || [];

    const wants = (pred) => metrics.filter((m) => pred(m));

    if (/остаточн.*конец|конец.*остаточн|остаточн.*на\s+конец/i.test(t)) {
        selected.push(
            ...wants((m) => m.suggested_measure === 'residual_close'),
            ...wants((m) => /остаточн/i.test((m.header_path || []).join(' ')) && /конец/i.test((m.header_path || []).join(' ')))
        );
    }
    if (/остаточн.*начал|начал.*остаточн/i.test(t)) {
        selected.push(...wants((m) => m.suggested_measure === 'residual_open'));
    }
    if (/стоимост.*конец|конец.*стоимост/i.test(t) && !/остаточн/i.test(t)) {
        selected.push(...wants((m) => m.suggested_measure === 'cost_close'));
    }
    if (/стоимост.*начал|начал.*стоимост/i.test(t)) {
        selected.push(...wants((m) => m.suggested_measure === 'cost_open'));
    }
    if (/амортизац/i.test(t) && !/без\s+амортизац/i.test(t)) {
        selected.push(...wants((m) => /amort/i.test(m.suggested_measure || '')));
    }
    if (/без\s+амортизац/i.test(t)) {
        return { year, measures: selected, exclude_amort: true };
    }

    if (selected.length === 0 && (t.includes('начал') || t.includes('конец'))) {
        if (t.includes('начал')) selected.push(...wants((m) => /open|начало/i.test(m.suggested_measure || '')));
        if (t.includes('конец')) selected.push(...wants((m) => /close|конец/i.test(m.suggested_measure || '')));
    }

    const uniq = [];
    const seen = new Set();
    for (const m of selected) {
        if (!m.suggested_measure || seen.has(m.suggested_measure)) continue;
        seen.add(m.suggested_measure);
        uniq.push(m);
    }

    return { year, measures: uniq, exclude_amort: /без\s+амортизац/i.test(t) };
}

function measuresToRuleColumns(matchResult, catalog) {
    const { year, measures, exclude_amort } = matchResult;
    const cols = [];

    for (const m of measures) {
        if (!m.suggested_measure) continue;
        if (exclude_amort && /amort/i.test(m.suggested_measure)) continue;
        const label = m.header_path.join(' — ') || METRIC_FIELDS_01[m.suggested_measure]?.defaultSuffix || m.suggested_measure;
        cols.push({
            target: `${year} - ${label}`,
            source: { type: 'metric', measure: m.suggested_measure },
        });
    }
    return cols;
}

module.exports = {
    buildColumnCatalog,
    matchUserTextToMeasures,
    measuresToRuleColumns,
    extractHierarchyTreeSample,
    matchMeasureFromHeader,
    colLetter,
    loadSheetData,
    findOsvCardHeaderBlock,
    buildOsvHierarchyCatalog,
};
