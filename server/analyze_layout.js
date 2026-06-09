const { buildColumnCatalog } = require('./excel_column_catalog');
const { inferTreeLevels } = require('./infer_tree_levels');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { detectUkCard, isUkDateLabel } = require('./uk_card_detect');
const { probeUkLayout } = require('./uk_layout_probe');

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

/**
 * Детерминированный анализ layout без LLM.
 * @param {Buffer} buffer
 * @param {string} [sheetName]
 */
function analyzeLayout(buffer, sheetName, options = {}) {
    const loaded = readSheetWithMeta(buffer, sheetName, {
        useExcelProbe: options.useExcelProbe !== false,
        fileName: options.fileName,
        probe: options.probe,
    });
    const {
        data,
        sheetNames,
        sheetName: usedSheet,
        hasOutline,
        styleHints,
        excelProbe,
        rowOutlineLevels,
        mergedRanges,
        rowMeta,
        skipRowIndices,
        hiddenRowIndices,
    } = loaded;

    const candidates = [];

    const hasPeriodBlock = data.some((row) =>
        /На начало периода/i.test(cellText(row, 1) + cellText(row, 2))
    );
    let wideHeaderRow = -1;
    for (let i = 0; i < Math.min(data.length, 25); i++) {
        const labels = data[i].map((c) => String(c || '').trim());
        if (!labels.some((t) => t === 'Группа' || t === 'ОС')) continue;
        const yearCols = labels.filter((l) => /^\d{4}\s*-\s*(начало|амортизация|конец)/i.test(l));
        if (yearCols.length >= 3) {
            wideHeaderRow = i;
            break;
        }
    }

    const sheetLower = usedSheet.toLowerCase();
    const has76Card =
        data.some((r) => {
            const label = cellText(r, 0);
            if (!label || isUkDateLabel(label)) return false;
            return /^76(\.|,|\s)/.test(label) || /^\d{2}(\.\d+)+[,\s]/.test(label);
        }) &&
        data.some((r) => /^Договор\s/i.test(cellText(r, 0))) &&
        data.some((r) => /^Контрагент/i.test(cellText(r, 0)));
    const has08Rows = data.some((r) => /^08(\.|$)/.test(cellText(r, 0)));
    const has08 =
        has08Rows ||
        (/08|оборотно-сальдов/i.test(sheetLower) && !has76Card) ||
        (/осв/i.test(sheetLower) && has08Rows && !has76Card);

    if (has76Card) {
        candidates.push({
            layout_type: 'hierarchy_osv',
            confidence: 0.95,
            profile_hint: 'os_account_card_76',
            suggested_sheet: usedSheet,
            description: 'Карточка счёта 76: счёт → подразделение → контрагент → договор',
        });
    }
    const has01 = /01|амортизац/i.test(sheetLower) || hasPeriodBlock;
    const hasUkDates = data.some((row) => /^\d{2}\.\d{2}\.\d{4}/.test(cellText(row, 0)));
    const ukDetect = detectUkCard(data, options.fileName);

    if (ukDetect.isUk) {
        candidates.push({
            layout_type: 'fixed_columns',
            confidence: ukDetect.confidence,
            profile_hint: 'uk_card',
            data_start_row: 7,
            description: 'Карточка счёта УК (58.01): дата + БУ/Кол. + фиксированные колонки',
        });
    }

    if (has08) {
        candidates.push({
            layout_type: 'hierarchy_osv',
            confidence: 0.9,
            profile_hint: 'os_osv_08',
            suggested_sheet: sheetNames.find((s) => /08/i.test(s)) || usedSheet,
            description: 'ОСВ по счёту 08: иерархия счёт → подразделение → объект → обороты',
        });
    }

    if (wideHeaderRow >= 0) {
        candidates.push({
            layout_type: 'wide_metrics',
            confidence: 0.85,
            profile_hint: 'os_wide_years',
            header_row: wideHeaderRow,
            suggested_sheet: usedSheet,
            description: 'Годы в шапке колонок (2024 - начало | амортизация | конец)',
        });
    }

    if (has01 || hasPeriodBlock) {
        candidates.push({
            layout_type: 'hierarchy_rows',
            confidence: hasPeriodBlock ? 0.9 : 0.7,
            profile_hint: 'os_depreciation_01',
            suggested_sheet: sheetNames.find((s) => /01/i.test(s)) || usedSheet,
            description: 'Ведомость ОС: дерево в колонке A, метрики в строке',
        });
    }

    if (hasUkDates && !has01 && !has08 && !ukDetect.isUk) {
        candidates.push({
            layout_type: 'fixed_columns',
            confidence: 0.8,
            profile_hint: 'uk_card',
            data_start_row: 7,
            description: 'Карточка счёта: дата в первой колонке, фиксированные колонки',
        });
    }

    if (candidates.length === 0) {
        const sampleRows = data.slice(0, 30);
        const hierarchyLike = sampleRows.filter((r) => cellText(r, 0) && rowHasNumbers(r)).length > 5;
        if (hierarchyLike) {
            candidates.push({
                layout_type: 'hierarchy_rows',
                confidence: 0.5,
                profile_hint: 'unknown_hierarchy',
                description: 'Похоже на иерархию в первой колонке (низкая уверенность)',
            });
        } else {
            candidates.push({
                layout_type: 'fixed_columns',
                confidence: 0.4,
                profile_hint: 'unknown_table',
                description: 'Табличный формат (низкая уверенность)',
            });
        }
    }

    candidates.sort((a, b) => b.confidence - a.confidence);
    const recommended = candidates[0] || null;

    const { catalog, sample_leaf_rows } = (() => {
        try {
            const built = buildColumnCatalog(buffer, usedSheet, {
                layout_type: recommended?.layout_type,
                preloaded: loaded,
            });
            return {
                catalog: built.catalog,
                sample_leaf_rows: built.catalog.sample_leaf_rows,
            };
        } catch (e) {
            return { catalog: null, sample_leaf_rows: [] };
        }
    })();

    const hierarchy_tree_sample = catalog?.hierarchy_tree_sample || [];

    const previewRows = data.slice(0, 40);
    const previewText = previewRows.map((row) => row.join('\t')).join('\n');

    const tree_inference = inferTreeLevels(data, {
        sheetName: usedSheet,
        recommended,
        column_catalog: catalog,
        hierarchy_tree_sample,
    });

    const uk_probe =
        recommended?.profile_hint === 'uk_card' || catalog?.layout_type === 'fixed_columns' && catalog?.uk_quantity_detect
            ? probeUkLayout(data, {
                  data_start_row: catalog?.data_start_row ?? recommended?.data_start_row ?? 7,
                  indicator_column: catalog?.uk_quantity_detect?.indicator_column ?? 5,
              })
            : null;

    return {
        sheetNames,
        sheetName: usedSheet,
        rowCount: data.length,
        candidates: candidates.slice(0, 3),
        recommended,
        previewText,
        column_catalog: catalog,
        sample_leaf_rows: sample_leaf_rows || catalog?.sample_leaf_rows || [],
        hierarchy_tree_sample,
        tree_inference,
        osv_tree_profile: tree_inference.profileId,
        has_row_outline: hasOutline || catalog?.has_row_outline || false,
        row_outline_levels: rowOutlineLevels,
        uk_quantity_detect: catalog?.uk_quantity_detect || null,
        uk_probe,
        preview_tsv: catalog?.preview_tsv || previewText,
        excel_probe: excelProbe ? { ok: true, engine: excelProbe.probe_engine || 'openpyxl' } : { ok: false },
        style_hints: styleHints,
        row_meta: rowMeta,
        merged_ranges: mergedRanges,
        skip_row_indices: skipRowIndices,
        hidden_row_indices: hiddenRowIndices,
    };
}

module.exports = { analyzeLayout };
