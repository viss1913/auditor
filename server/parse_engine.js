const fs = require('fs');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const {
    METRIC_FIELDS_01,
    findYearWideHeader,
    detect01PeriodBlock,
    FLAT_HEADERS_08,
} = require('./smart_parse_os');
const { validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const { walkHierarchy, resolveHierarchyFields } = require('./hierarchy_walker');
const { walkTree } = require('./tree_walker');
const { applyTreeProfileToRule } = require('./tree_profiles');
const { isAccountCard76Data } = require('./scenarios/registry');

const OSV_COLUMN_ALIASES = {
    'Счёт': 'Счёт, наименование счета',
    'Счёт, наименование счета': 'Счёт',
};

function loadSheetRows(filePath, sheetName) {
    const ext = require('path').extname(filePath).toLowerCase();
    const loaded = readSheetWithMeta(filePath, sheetName, {
        useExcelProbe: ext === '.xlsx' || ext === '.xlsm',
        fileName: require('path').basename(filePath),
    });
    return {
        data: loaded.data,
        sheetName: loaded.sheetName,
        rowOutlineLevels: loaded.rowOutlineLevels,
        hasOutline: loaded.hasOutline,
        styleHints: loaded.styleHints,
        skipRowIndices: loaded.skipRowIndices,
        hiddenRowIndices: loaded.hiddenRowIndices,
        excelProbe: loaded.excelProbe,
    };
}

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

function rowHasAmounts(row, fromCol, toCol) {
    for (let c = fromCol; c <= toCol; c++) {
        const n = toNum(row[c]);
        if (n !== null && n !== 0) return true;
    }
    return false;
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

function buildLeafChecker(rule) {
    const ld = rule.hierarchy?.leaf_rules || rule.leaf_detection || {};
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
    return (name) => {
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

function shouldSkipRow(name, rule) {
    const patterns = rule.filters?.skip_row_patterns || [];
    return patterns.some((p) => new RegExp(p, 'i').test(name));
}

function resolveMetricsFromRule(rule) {
    return rule.columns
        .filter((c) => c.source?.type === 'metric')
        .map((c) => {
            const mf = METRIC_FIELDS_01[c.source.measure];
            const label =
                c.target.includes(' - ')
                    ? c.target.split(' - ').slice(1).join(' - ')
                    : c.target;
            return {
                field: c.source.measure,
                column_label: label || mf?.defaultSuffix || c.source.measure,
                col: mf?.col,
            };
        })
        .filter((m) => m.col != null);
}

function metricHeadersForYear(year, metricEntries) {
    return metricEntries.map((m) => (year ? `${year} - ${m.column_label}` : m.column_label));
}

/** В выгрузке 1С имя ОС чаще в A (0), в B — «Стоимость» */
function detectNameColumn(data, startRow = 7) {
    let text0 = 0;
    let text1 = 0;
    for (let i = startRow; i < Math.min(data.length, 45); i++) {
        const a = cellText(data[i], 0);
        const b = cellText(data[i], 1);
        if (a.length >= 12 && !/^\d+([.,]\d+)?$/.test(a.replace(/\s/g, ''))) text0++;
        if (b.length >= 12 && !/^\d+([.,]\d+)?$/.test(b.replace(/\s/g, ''))) text1++;
    }
    return text1 > text0 + 2 ? 1 : 0;
}

function resolveOutputPlan(rule, year) {
    const plan = [];
    for (const col of rule.columns || []) {
        const src = col.source || {};
        if (src.type === 'entity_from_header') {
            plan.push({ target: col.target || 'Юрлицо', kind: 'entity' });
        } else if (src.type === 'composite_cell') {
            plan.push({
                target: col.target,
                kind: 'composite_cell',
                col: src.column,
                extract: src.extract || {},
            });
        } else if (src.type === 'hierarchy_field') {
            const field = src.field || 'asset_name';
            if (field === 'group') plan.push({ target: col.target || 'Группа', kind: 'group', field });
            else if (field === 'unit') plan.push({ target: col.target || 'Узел', kind: 'hierarchy', field });
            else if (field === 'parent_unit')
                plan.push({ target: col.target || 'Родитель', kind: 'hierarchy', field });
            else if (field === 'path') plan.push({ target: col.target || 'Путь', kind: 'hierarchy', field });
            else if (field === 'subdivision')
                plan.push({ target: col.target || 'Подразделение', kind: 'subdivision', field });
            else if (field === 'account')
                plan.push({ target: col.target || 'Счёт', kind: 'account', field });
            else if (field === 'counterparty')
                plan.push({ target: col.target || 'Контрагент', kind: 'counterparty', field });
            else if (field === 'contract')
                plan.push({ target: col.target || 'Договор', kind: 'contract', field });
            else if (field === 'year' || /^год$/i.test(col.target))
                plan.push({ target: col.target || 'Год', kind: 'year', field });
            else plan.push({ target: col.target || 'ОС', kind: 'asset', field });
        } else if (src.type === 'metric') {
            const mf = METRIC_FIELDS_01[src.measure];
            if (!mf) continue;
            const label = col.target.includes(' - ')
                ? col.target.split(' - ').slice(1).join(' - ')
                : col.target;
            const header = year ? `${year} - ${label || mf.defaultSuffix}` : label || mf.defaultSuffix;
            plan.push({
                target: header,
                kind: 'metric',
                col: mf.col,
            });
        } else if (/^год$/i.test(col.target)) {
            plan.push({ target: col.target, kind: 'year' });
        }
    }
    return plan;
}

function extractCompositeCellValue(cellValue, extract = {}) {
    const s = String(cellValue ?? '').trim();
    if (!s) return null;
    if (!extract?.pattern) return null;
    let re;
    try {
        re = new RegExp(extract.pattern, 'i');
    } catch {
        return null;
    }
    const m = re.exec(s);
    if (!m) return null;
    const group = Number.isInteger(extract.group) ? extract.group : 0;
    let out = m[group] ?? m[0] ?? '';
    out = String(out).trim();
    if (!out) return null;

    if (extract?.transform === 'date_ddmmyyyy') {
        const dm = out.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (dm) return `${dm[3]}-${dm[2]}-${dm[1]}`;
    }
    return out;
}

function hierarchyRowsStrategy(data, rule, warnings, walkOptions = {}) {
    const { entity, reportLabel } = readMetaFromHeader(data);
    const yearMatch = reportLabel.match(/за\s+.*?(\d{4})\s*г/i) || reportLabel.match(/(\d{4})\s*г/i);
    const year = yearMatch ? yearMatch[1] : '';

    let nameCol = rule.layout?.name_column;
    if (nameCol === undefined || nameCol === null) {
        nameCol = detectNameColumn(data);
    } else if (nameCol === 1 && detectNameColumn(data) === 0) {
        warnings.push(
            'Колонка B в файле — обычно «Стоимость»; имя ОС взято из колонки A (как в типовой выгрузке 1С)'
        );
        nameCol = 0;
    }

    const plan = resolveOutputPlan(rule, year);
    const headers = plan.map((p) => p.target);
    const metricCols = plan.filter((p) => p.kind === 'metric');
    const maxCol = Math.max(...metricCols.map((m) => m.col), 11);

    const walkRule = {
        ...rule,
        layout: { ...rule.layout, name_column: nameCol },
    };
    const { rows: leafRows, warnings: walkWarnings } = walkHierarchy(data, walkRule, {
        maxCol,
        ...walkOptions,
    });
    warnings.push(...walkWarnings);

    const results = [];
    for (const leaf of leafRows) {
        const rowObj = {};
        for (const p of plan) {
            if (p.kind === 'entity') rowObj[p.target] = entity;
            else if (p.kind === 'group') rowObj[p.target] = resolveHierarchyFields('group', leaf.path);
            else if (p.kind === 'subdivision')
                rowObj[p.target] = resolveHierarchyFields('subdivision', leaf.path);
            else if (p.kind === 'hierarchy')
                rowObj[p.target] = resolveHierarchyFields(p.field, leaf.path, leaf.leaf_name);
            else if (p.kind === 'asset') rowObj[p.target] = leaf.leaf_name;
            else if (p.kind === 'year') rowObj[p.target] = year;
            else if (p.kind === 'metric') rowObj[p.target] = toNum(leaf.row[p.col]);
            else if (p.kind === 'composite_cell')
                rowObj[p.target] = extractCompositeCellValue(leaf.row[p.col], p.extract);
        }
        results.push(rowObj);
    }

    if (results.length === 0) {
        warnings.push(
            `Строк не найдено (колонка имён: ${nameCol}). Проверьте лист «${rule.meta?.sheet_name || ''}» и leaf_rules.`
        );
    }

    return { headers, rows: results, warnings };
}

function wideMetricsStrategy(data, rule, warnings) {
    const headerInfo = findYearWideHeader(data);
    if (!headerInfo) {
        warnings.push('Не найдена шапка с годами (2024 - начало | …); пробуем иерархию одного периода');
        return hierarchyRowsStrategy(data, rule, warnings);
    }

    const metricEntries = resolveMetricsFromRule(rule);
    const allowed = new Set(metricEntries.map((m) => m.column_label.toLowerCase()));
    const filteredYearCols = headerInfo.yearCols.filter((yc) => {
        if (allowed.size === 0) return true;
        return [...allowed].some(
            (a) =>
                yc.metric === a ||
                (a.includes('амортизация') && yc.metric === 'амортизация') ||
                (a.includes('начало') && yc.metric === 'начало') ||
                (a.includes('конец') && yc.metric === 'конец')
        );
    });
    const years = [...new Set(filteredYearCols.map((c) => c.year))];
    const { entity } = readMetaFromHeader(data);
    const headers = ['Юрлицо', 'Группа', 'Подразделение', 'ОС'];
    for (const y of years) {
        for (const m of metricEntries) {
            headers.push(`${y} - ${m.column_label}`);
        }
    }

    const results = [];
    let pendingMeta = null;
    const firstMetricCol = Math.min(...headerInfo.yearCols.map((c) => c.col));

    const flushMetaRow = (metaRow, valuesRow) => {
        const group = cellText(metaRow, 0);
        const subdiv = cellText(metaRow, 1);
        const asset = cellText(metaRow, 2);
        if (!group && !subdiv && !asset) return;
        const rowObj = { Юрлицо: entity, Группа: group, Подразделение: subdiv, ОС: asset || subdiv };
        if (!asset && subdiv) {
            rowObj['Подразделение'] = '';
            rowObj['ОС'] = subdiv;
        }
        for (const yc of filteredYearCols) {
            const entry = metricEntries.find((m) => {
                const lbl = m.column_label.toLowerCase();
                return (
                    yc.metric === lbl ||
                    (yc.metric === 'амортизация' && lbl.includes('амортизация')) ||
                    (yc.metric === 'начало' && lbl.includes('начало')) ||
                    (yc.metric === 'конец' && lbl.includes('конец'))
                );
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

    return { headers, rows: results, warnings };
}

function resolveOsvProfileKey(data, rule) {
    if (rule.meta?.profile_hint === 'os_account_card') return 'os_76_card';
    const startRow = rule.layout?.data_start_row ?? 0;
    if (isAccountCard76Data(data, startRow)) return 'os_76_card';
    return 'os_08';
}

function hierarchyOsvStrategy(data, rule, warnings, walkOptions = {}) {
    const walkRule = JSON.parse(JSON.stringify(rule));
    const profileKey = resolveOsvProfileKey(data, walkRule);
    const needsProfile =
        !walkRule.hierarchy?.levels?.length || walkRule.hierarchy?.leaf?.kind === 'os_08_object';

    if (needsProfile || profileKey === 'os_76_card') {
        applyTreeProfileToRule(walkRule, profileKey);
        if (profileKey === 'os_76_card' && rule.meta?.profile_hint !== 'os_account_card') {
            warnings.push(
                'Распознана карточка счёта 76 (договоры/контрагенты). Разворачиваем дерево, не ОСВ 08.'
            );
        }
    }

    const { rows: walked, warnings: walkWarnings } = walkTree(data, walkRule, walkOptions);
    warnings.push(...walkWarnings);

    const headers = rule.columns.map((c) => c.target);
    const rows = walked.map((full) => {
        const out = {};
        for (const h of headers) {
            const alias = OSV_COLUMN_ALIASES[h];
            out[h] = full[h] ?? (alias ? full[alias] : '') ?? '';
        }
        return out;
    });

    return { headers: headers.length ? headers : FLAT_HEADERS_08, rows, warnings };
}

function parseDate(str) {
    const m = String(str).match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!m) return null;
    return new Date(`${m[3]}-${m[2]}-${m[1]}`);
}

function extractUkOperationType(documentText) {
    const lines = String(documentText || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    if (lines.length >= 2) return lines[1];
    return lines[0] || '';
}

function matchesUkAccountFilters(dbAcc, crAcc, conditions) {
    if (conditions.debit_account_prefix && !dbAcc.startsWith(conditions.debit_account_prefix)) {
        return false;
    }
    if (conditions.debit_account && !dbAcc.startsWith(conditions.debit_account)) {
        return false;
    }
    if (conditions.credit_account_prefix && !crAcc.startsWith(conditions.credit_account_prefix)) {
        return false;
    }
    if (conditions.credit_account && !crAcc.startsWith(conditions.credit_account)) {
        return false;
    }
    return true;
}

function fixedColumnsStrategy(data, rule, warnings) {
    const skip = rule.layout?.skip_rows ?? 7;
    const map = rule.column_map || {};
    const conditions = rule.conditions || {};
    const multi = rule.multi_row || {};
    const dateStart = conditions.date_start ? new Date(conditions.date_start) : null;
    const dateEnd = conditions.date_end ? new Date(conditions.date_end) : null;

    const headers = rule.columns.map((c) => c.target);
    const results = [];
    let lastEntryAwaitingQty = null;

    const rows = data.slice(skip);
    rows.forEach((row) => {
        const firstCol = String(row[map.period ?? 0] ?? '').trim();
        const pokazatel = String(row[map.indicator ?? 5] ?? '').trim();
        const isDatePattern = /^\d{2}\.\d{2}\.\d{4}/.test(firstCol);

        if (multi.indicator_value && pokazatel === multi.indicator_value) {
            if (lastEntryAwaitingQty) {
                const qRaw = String(row[multi.quantity_column ?? map.amount ?? multi.amount_column ?? 7] ?? '0')
                    .replace(/\s/g, '')
                    .replace(',', '.');
                const q = parseFloat(qRaw);
                if (!Number.isNaN(q)) lastEntryAwaitingQty.quantity = q;
            }
            return;
        }

        if (!isDatePattern) return;

        const rowDate = parseDate(firstCol);
        const dbAcc = String(row[map.debit_account ?? 6] ?? '').trim();
        const crAcc = String(row[map.credit_account ?? 9] ?? '').trim();

        let isMatch = matchesUkAccountFilters(dbAcc, crAcc, conditions);
        if (dateStart && rowDate < dateStart) isMatch = false;
        if (dateEnd && rowDate > dateEnd) isMatch = false;

        if ((pokazatel === 'БУ' || pokazatel === '') && isMatch) {
            const analytics = String(row[map.analytics ?? 3] ?? '').trim();
            const parts = analytics.split(',').map((s) => s.trim());
            const name = parts.slice(0, Math.max(1, parts.length - 1)).join(', ') || analytics;
            const regNum = parts.length > 1 ? parts[parts.length - 1] : '';
            const docText = String(row[map.document ?? 1] ?? '').trim();

            const amountCol = multi.amount_column ?? map.amount ?? 7;
            let amountRaw = String(row[amountCol] ?? '0')
                .replace(/\s/g, '')
                .replace(',', '.')
                .replace(/[^\d.-]/g, '');
            let amount = parseFloat(amountRaw);
            if (Number.isNaN(amount)) amount = 0;

            const entry = {
                period: firstCol,
                document: docText,
                operation_type: extractUkOperationType(docText) || rule.output?.operation_type || '',
                name,
                regNum,
                quantity: 0,
                amount,
                debit_account: dbAcc,
                credit_account: crAcc,
            };
            results.push(entry);
            lastEntryAwaitingQty = entry;
        } else if (!isMatch) {
            lastEntryAwaitingQty = null;
        }
    });

    if (results.length === 0) {
        warnings.push('По правилу УК не найдено строк с датой и фильтрами');
    }

    return { headers, rows: results, warnings };
}

/**
 * @param {string} filePath
 * @param {Object} rule V2
 */
function runParseEngine(filePath, rule) {
    const validated = validateParsingRuleV2(rule);
    if (!validated.ok) {
        return { ok: false, errors: validated.errors };
    }

    const r = validated.rule;
    const sheetName = r.meta?.sheet_name;
    const {
        data,
        sheetName: usedSheet,
        rowOutlineLevels,
        hasOutline,
        styleHints,
        skipRowIndices,
        hiddenRowIndices,
    } = loadSheetRows(filePath, sheetName);
    const warnings = [];
    if (hasOutline) {
        warnings.push('tree_walker: используем группировку строк Excel (outline)');
    }
    if (styleHints?.likely_subtotal_rows?.length) {
        warnings.push(
            `excel_probe: пропускаем ${styleHints.likely_subtotal_rows.length} строк-подитогов (серый фон / Итого)`
        );
    }

    let result;
    const layoutType = r.layout.layout_type;
    const treeWalkOptions = {
        rowOutlineLevels,
        styleHints,
        skipRowIndices,
        hiddenRowIndices,
    };

    if (layoutType === 'wide_metrics') {
        result = wideMetricsStrategy(data, r, warnings);
    } else if (layoutType === 'hierarchy_osv') {
        result = hierarchyOsvStrategy(data, r, warnings, treeWalkOptions);
    } else if (layoutType === 'fixed_columns') {
        result = fixedColumnsStrategy(data, r, warnings);
    } else if (layoutType === 'hierarchy_rows') {
        if (findYearWideHeader(data) && !detect01PeriodBlock(data)) {
            warnings.push('Обнаружен wide-формат; для hierarchy_rows рекомендуется layout_type: wide_metrics');
        }
        result = hierarchyRowsStrategy(data, r, warnings, treeWalkOptions);
    } else {
        return { ok: false, errors: [`Неизвестный layout_type: ${layoutType}`] };
    }

    return {
        ok: true,
        rule: r,
        headers: result.headers,
        rows: result.rows,
        rowCount: result.rows.length,
        warnings,
        sheetName: usedSheet,
    };
}

function loadExampleRule(name) {
    const p = require('path').join(__dirname, 'rules', 'examples', name);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

module.exports = {
    runParseEngine,
    loadExampleRule,
    loadSheetRows,
    detectNameColumn,
};
