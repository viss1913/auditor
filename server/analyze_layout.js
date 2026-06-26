const { buildColumnCatalog } = require('./excel_column_catalog');
const { inferTreeLevels } = require('./infer_tree_levels');
const { readSheetWithMeta } = require('./excel_sheet_meta');
const { detectUkCard } = require('./uk_card_detect');
const { probeUkLayout } = require('./uk_layout_probe');
const { buildLayoutFingerprint, scoreProfileCandidates } = require('./layout_fingerprint');

function cellText(row, col) {
    if (!row) return '';
    return String(row[col] ?? '').trim();
}

function enrichCandidate(candidate, layout_fingerprint, sheetNames, usedSheet) {
    const c = {
        ...candidate,
        suggested_sheet: usedSheet,
    };
    if (c.profile_hint === 'os_wide_years' && layout_fingerprint.wideYearRow >= 0) {
        c.header_row = layout_fingerprint.wideYearRow;
    }
    if (c.profile_hint === 'os_osv_08' && sheetNames?.length) {
        c.suggested_sheet = sheetNames.find((s) => /08/i.test(s)) || usedSheet;
    }
    if (c.profile_hint === 'os_depreciation_01' && sheetNames?.length) {
        c.suggested_sheet = sheetNames.find((s) => /01/i.test(s)) || usedSheet;
    }
    if (c.profile_hint === 'uk_card' || c.profile_hint === 'ks_card') {
        c.data_start_row = 7;
    }
    return c;
}

/**
 * Детерминированный анализ layout без LLM.
 * @param {Buffer} buffer
 * @param {string} [sheetName]
 */
function analyzeLayout(buffer, sheetName, options = {}) {
    const loaded =
        options.loaded ||
        readSheetWithMeta(buffer, sheetName, {
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

    const layout_fingerprint = buildLayoutFingerprint(data, {
        hasOutline,
        rowOutlineLevels,
        sheetName: usedSheet,
        fileName: options.fileName,
    });

    let candidates = scoreProfileCandidates(layout_fingerprint).map((c) =>
        enrichCandidate(c, layout_fingerprint, sheetNames, usedSheet)
    );

    const ukDetect = detectUkCard(data, options.fileName);
    if (ukDetect.isUk) {
        const existing = candidates.find((c) => c.profile_hint === 'uk_card');
        if (existing) {
            existing.confidence = Math.max(existing.confidence, ukDetect.confidence);
            existing.description =
                'Карточка счёта УК (58.01): дата + БУ/Кол. + фиксированные колонки';
        } else {
            candidates.push(
                enrichCandidate(
                    {
                        layout_type: 'fixed_columns',
                        confidence: ukDetect.confidence,
                        profile_hint: 'uk_card',
                        description: 'Карточка счёта УК (58.01): дата + БУ/Кол. + фиксированные колонки',
                        fingerprint_reason: 'uk_card_detect',
                    },
                    layout_fingerprint,
                    sheetNames,
                    usedSheet
                )
            );
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
        recommended?.profile_hint === 'uk_card' ||
        (catalog?.layout_type === 'fixed_columns' && catalog?.uk_quantity_detect)
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
        layout_fingerprint,
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
