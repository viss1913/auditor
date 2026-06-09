const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

/** Целевой формат плоской таблицы (как «Мэппинг ручной») */
const FLAT_WIDE_PREFIX = ['Юрлицо', 'Группа', 'Подразделение', 'ОС'];

/** Колонки ведомости 01 (один период): индекс в строке Excel без пустой колонки A */
const METRIC_FIELDS_01 = {
    cost_open: { col: 1, defaultSuffix: 'стоимость на начало' },
    amort_open: { col: 2, defaultSuffix: 'амортизация на начало' },
    residual_open: { col: 3, defaultSuffix: 'начало' },
    cost_increase: { col: 4, defaultSuffix: 'увеличение стоимости' },
    amort_charge: { col: 5, defaultSuffix: 'амортизация' },
    cost_decrease: { col: 6, defaultSuffix: 'уменьшение стоимости' },
    amort_writeoff: { col: 7, defaultSuffix: 'списание амортизации' },
    cost_close: { col: 8, defaultSuffix: 'стоимость на конец' },
    amort_close: { col: 9, defaultSuffix: 'амортизация на конец' },
    residual_close: { col: 10, defaultSuffix: 'остаточная на конец' },
};

const DEFAULT_OUTPUT_METRICS_01 = [
    { field: 'residual_open', column_label: 'начало' },
    { field: 'amort_charge', column_label: 'амортизация' },
    { field: 'residual_close', column_label: 'конец' },
];

const { walkOsvHierarchy } = require('./osv_hierarchy');

const FLAT_HEADERS_08 = [
    'Юрлицо',
    'Счёт',
    'Подразделение',
    'Контрагент',
    'Договор',
    'Объект',
    'Период',
    'Год',
    'Сальдо Дт начало',
    'Сальдо Кт начало',
    'Оборот Дт',
    'Оборот Кт',
    'Сальдо Дт конец',
    'Сальдо Кт конец',
];

function loadSheetRows(filePath, sheetName) {
    const workbook = xlsx.readFile(filePath);
    const name =
        sheetName && workbook.SheetNames.includes(sheetName)
            ? sheetName
            : workbook.SheetNames.find((s) => /исходн/i.test(s)) ||
              workbook.SheetNames.find((s) => s.includes('01')) ||
              workbook.SheetNames[0];
    const worksheet = workbook.Sheets[name];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    return { data, sheetName: name, workbook };
}

function toNum(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    const s = String(val).replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
}

function rowHasAmounts(row, fromCol, toCol) {
    for (let c = fromCol; c <= toCol; c++) {
        const n = toNum(row[c]);
        if (n !== null && n !== 0) return true;
    }
    return false;
}

function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

function readMetaFromHeader(data) {
    let entity = '';
    let reportLabel = '';
    for (const row of data.slice(0, 10)) {
        const t0 = cellText(row, 0);
        const t1 = cellText(row, 1);
        if (!entity && /^ОАО|^ООО|^АО|^ПАО/i.test(t0)) entity = t0;
        if (!entity && /^ОАО|^ООО|^АО|^ПАО/i.test(t1)) entity = t1;
        const title = t0 || t1;
        if (/ведомость|амортизац/i.test(title)) reportLabel = title;
    }
    return { entity, reportLabel };
}

/** Формат «Исходная выгрузка»: один период, колонки начало/оборот/конец */
function detect01PeriodBlock(data) {
    return data.some((row) => /На начало периода/i.test(cellText(row, 1) + cellText(row, 2)));
}

/** Формат с годами в шапке: 2022 - начало | амортизация | конец */
function findYearWideHeader(data) {
    for (let i = 0; i < Math.min(data.length, 25); i++) {
        const row = data[i];
        const labels = row.map((c) => String(c || '').trim());
        if (!labels.some((t) => t === 'Группа' || t === 'ОС')) continue;
        const yearCols = [];
        labels.forEach((label, col) => {
            const m = label.match(/^(\d{4})\s*-\s*(начало|амортизация|конец)/i);
            if (m) yearCols.push({ col, year: m[1], metric: m[2].toLowerCase(), header: label });
        });
        if (yearCols.length >= 3) {
            return { headerRowIndex: i, yearCols };
        }
    }
    return null;
}

function buildLeafChecker(ruleJSON) {
    const ld = ruleJSON.leaf_detection || {};
    const minLen = ld.min_name_length ?? 20;
    const invRes = (ld.inventory_patterns || [
        '\\d{2}\\.\\d{2}\\.\\d{4}',
        'инв\\.?',
        '№\\s*[\\dA-Z-]',
        '80-\\d+',
        '\\d{6,}',
    ]).map((p) => new RegExp(p, 'i'));
    const skipRes = (ld.skip_name_patterns || ['^ОП\\s', '^РТК\\s', '^КЦ$', '^Итого']).map(
        (p) => new RegExp(p, 'i')
    );

    return function isLeafAssetName(name) {
        const t = String(name || '').trim();
        if (!t) return false;
        for (const re of skipRes) {
            if (re.test(t)) return false;
        }
        for (const re of invRes) {
            if (re.test(t)) return true;
        }
        if (/^ППА\s/i.test(t)) return true;
        if (t.length >= minLen) return true;
        return false;
    };
}

function normalizeMetricSpec(item) {
    if (typeof item === 'string') return { field: item };
    if (item && typeof item === 'object' && item.field) return item;
    return null;
}

/** Какие колонки выводить — из правила (диалог с ИИ) или по умолчанию */
function resolveOutputMetrics01(ruleJSON) {
    const raw = ruleJSON.output_metrics;
    if (!Array.isArray(raw) || raw.length === 0) {
        return DEFAULT_OUTPUT_METRICS_01.map((m) => resolveMetricEntry(m));
    }
    return raw.map(normalizeMetricSpec).filter(Boolean).map((m) => resolveMetricEntry(m));
}

function resolveMetricEntry(spec) {
    const def = METRIC_FIELDS_01[spec.field];
    if (!def) {
        throw new Error(`Неизвестное поле output_metrics: ${spec.field}`);
    }
    const label = spec.column_label || spec.label || def.defaultSuffix;
    return { field: spec.field, col: def.col, column_label: label };
}

function metricHeadersForYears(years, metricEntries) {
    const headers = [...FLAT_WIDE_PREFIX];
    const sorted = [...years].sort();
    for (const y of sorted) {
        for (const m of metricEntries) {
            headers.push(`${y} - ${m.column_label}`);
        }
    }
    return headers;
}

function allowedWideMetricSuffixes(metricEntries) {
    return new Set(
        metricEntries.map((m) => {
            const lbl = m.column_label.toLowerCase();
            if (lbl.includes('амортизация') && !lbl.includes('на начало') && !lbl.includes('на конец')) {
                return 'амортизация';
            }
            if (lbl.includes('стоимость') && lbl.includes('начало')) return 'начало';
            if (lbl.includes('стоимость') && lbl.includes('конец')) return 'конец';
            if (lbl === 'начало' || lbl.includes('остаточн') && lbl.includes('начало')) return 'начало';
            if (lbl === 'конец' || lbl.includes('остаточн') && lbl.includes('конец')) return 'конец';
            return lbl;
        })
    );
}

function emptyWideRow(entity, headers) {
    const row = {};
    headers.forEach((h) => {
        row[h] = '';
    });
    row['Юрлицо'] = entity;
    return row;
}

/**
 * Исходная выгрузка (один год, иерархия в col A) → плоская строка.
 * начало = остаточная на начало, амортизация = начисление, конец = остаточная на конец.
 */
function parse01PeriodBlock(data, ruleJSON) {
    const isLeaf = buildLeafChecker(ruleJSON);
    const metricEntries = resolveOutputMetrics01(ruleJSON);
    const { entity, reportLabel } = readMetaFromHeader(data);
    const yearMatch = reportLabel.match(/за\s+.*?(\d{4})\s*г/i) || reportLabel.match(/(\d{4})\s*г/i);
    const year = yearMatch ? yearMatch[1] : '';
    const headers = metricHeadersForYears(year ? [year] : [], metricEntries);

    let groupName = '';
    let subdivision = '';
    const results = [];
    const GROUP_HINT =
        /^(Здания|Сооружения|Машины|Земельные|Транспорт|Офисное|Производственный|Другие виды)/i;

    for (const row of data) {
        const name = cellText(row, 0);
        if (!name || /^Итого/i.test(name)) continue;
        if (/^(Группа учета|Подразделение|Основное средство|Выводимые данные|Ведомость)/i.test(name)) {
            continue;
        }

        const hasNumbers = rowHasAmounts(row, 1, 11);
        if (!hasNumbers) continue;

        if (isLeaf(name)) {
            const rowObj = emptyWideRow(entity, headers);
            rowObj['Группа'] = groupName;
            rowObj['Подразделение'] = subdivision;
            rowObj['ОС'] = name;
            if (year) {
                for (const m of metricEntries) {
                    rowObj[`${year} - ${m.column_label}`] = toNum(row[m.col]);
                }
            }
            results.push(rowObj);
            continue;
        }

        if (/^ОП\s|^РТК\s|^КЦ$/i.test(name)) {
            subdivision = name;
            continue;
        }

        if (GROUP_HINT.test(name) || (name.length < 48 && !name.includes(',') && !/^ППА/i.test(name))) {
            groupName = name;
            if (!/^ОП\s|^РТК\s/i.test(name)) subdivision = '';
        }
    }

    return { rows: results, headers };
}

/**
 * Широкий формат / ступенчатые строки (как на скрине мэппинга).
 */
function parse01YearWide(data, ruleJSON, headerInfo) {
    const { entity } = readMetaFromHeader(data);
    const metricEntries = resolveOutputMetrics01(ruleJSON);
    const allowed = allowedWideMetricSuffixes(metricEntries);
    const filteredYearCols = headerInfo.yearCols.filter((yc) => allowed.has(yc.metric));
    const years = [...new Set(filteredYearCols.map((c) => c.year))];
    const headers = metricHeadersForYears(years, metricEntries);
    const firstMetricCol = Math.min(...headerInfo.yearCols.map((c) => c.col));

    const results = [];
    let pendingMeta = null;

    const flushMetaRow = (metaRow, valuesRow) => {
        const group = cellText(metaRow, 0);
        const subdiv = cellText(metaRow, 1);
        const asset = cellText(metaRow, 2);
        if (!group && !subdiv && !asset) return;
        if (!asset && !subdiv) return;

        const rowObj = emptyWideRow(entity, headers);
        rowObj['Группа'] = group;
        rowObj['Подразделение'] = subdiv;
        rowObj['ОС'] = asset || subdiv;
        if (!asset && subdiv) {
            rowObj['Подразделение'] = '';
            rowObj['ОС'] = subdiv;
        }

        for (const yc of filteredYearCols) {
            const entry = metricEntries.find((m) => {
                const lbl = m.column_label.toLowerCase();
                return yc.metric === 'амортизация'
                    ? lbl === 'амортизация' || (lbl.includes('амортизация') && !lbl.includes('на '))
                    : yc.metric === lbl || (yc.metric === 'начало' && lbl.includes('начало')) || (yc.metric === 'конец' && lbl.includes('конец'));
            });
            if (entry) {
                rowObj[`${yc.year} - ${entry.column_label}`] = toNum(valuesRow[yc.col]);
            }
        }
        results.push(rowObj);
    };

    for (let i = headerInfo.headerRowIndex + 1; i < data.length; i++) {
        const row = data[i];
        const label0 = cellText(row, 0);
        if (!label0 && !rowHasAmounts(row, firstMetricCol, row.length - 1)) continue;
        if (/^Итого/i.test(label0)) continue;

        const hasMeta = cellText(row, 0) || cellText(row, 1) || cellText(row, 2);
        const hasNums = rowHasAmounts(row, firstMetricCol, row.length - 1);

        if (hasMeta && !hasNums) {
            pendingMeta = row;
            continue;
        }

        if (hasNums && pendingMeta) {
            flushMetaRow(pendingMeta, row);
            pendingMeta = null;
            continue;
        }

        if (hasMeta && hasNums) {
            flushMetaRow(row, row);
            pendingMeta = null;
        }
    }

    return { rows: results, headers };
}

function parse01Flat(data, ruleJSON) {
    const wideHeader = findYearWideHeader(data);
    if (wideHeader) {
        return parse01YearWide(data, ruleJSON, wideHeader);
    }
    if (detect01PeriodBlock(data)) {
        return parse01PeriodBlock(data, ruleJSON);
    }
    return parse01PeriodBlock(data, ruleJSON);
}

function parse08Flat(data, ruleJSON) {
    const { rows } = walkOsvHierarchy(data);
    return { rows, headers: FLAT_HEADERS_08 };
}

/**
 * @param {string} filePath
 * @param {Object} ruleJSON
 */
function smartParseOS(filePath, ruleJSON) {
    const sheetName = ruleJSON.conditions?.sheet_name;
    const { data, sheetName: usedSheet } = loadSheetRows(filePath, sheetName);

    let rows;
    let headers;

    if (ruleJSON.variant === '08_osv') {
        ({ rows, headers } = parse08Flat(data, ruleJSON));
    } else {
        ({ rows, headers } = parse01Flat(data, ruleJSON));
    }

    console.log(`[smartParseOS] ${ruleJSON.variant} | лист «${usedSheet}» | строк: ${rows.length}`);

    return { rows, variant: ruleJSON.variant, sheetName: usedSheet, headers };
}

function loadRuleFromFile(rulePath) {
    const raw = fs.readFileSync(rulePath, 'utf8');
    return JSON.parse(raw);
}

function rowsToSheet(rows, headers) {
    const aoa = [headers, ...rows.map((r) => headers.map((h) => r[h] ?? ''))];
    return xlsx.utils.aoa_to_sheet(aoa);
}

function writeFlatExcel(rows, headers, outPath) {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, rowsToSheet(rows, headers), 'Плоская_таблица');
    xlsx.writeFile(wb, outPath);
}

module.exports = {
    smartParseOS,
    loadRuleFromFile,
    writeFlatExcel,
    FLAT_WIDE_PREFIX,
    FLAT_HEADERS_08,
    findYearWideHeader,
    detect01PeriodBlock,
    resolveOutputMetrics01,
    METRIC_FIELDS_01,
};
