const { detectSourceKind } = require('../file_dispatch');
const { buildStructureOntology, STRUCTURE_TO_SCENARIO } = require('../structure_ontology');
const { SCENARIO_CATALOG } = require('../scenarios/catalog');
const { detectJournalStructure, scoreAllStructures } = require('../structure_classifier');
const { buildLayoutFingerprint } = require('../layout_fingerprint');
const { fingerprintHash } = require('./rule_cache');

function numberedLines(lines, start = 0, limit = 120) {
    return (lines || [])
        .slice(start, start + limit)
        .map((l, i) => `${start + i}: ${l}`)
        .join('\n');
}

function rowsToTsv(data, startRow = 0, limit = 35) {
    return (data || [])
        .slice(startRow, startRow + limit)
        .map((row) => (row || []).map((c) => String(c ?? '').replace(/\t/g, ' ')).join('\t'))
        .join('\n');
}

const SCENARIO_CATALOG_HINTS = {
    uk_card: 'журнал 1С, БУ+Кол. в строках, счёт 58.01, Текущее сальдо БУ/Кол.',
    uk_osv_58: 'ОСВ 58, дерево, БУ/Кол. в шапке колонок',
    ks_card_composite_raw: 'журнал 1С Период+Дт/Кт, без пар БУ/Кол.',
    ks_card_flat: 'обработанная КС, колонки разнесены',
    os_76_account_card: 'дерево: Договор + Контрагент + 76',
    os_08_osv: 'ОСВ 08, счета 08*',
    os_01_hierarchy: 'ведомость ОС с деревом',
    os_01_flat: 'ведомость ОС плоская',
    os_01_cost_only: 'ОС только стоимость',
    wide_metrics: 'годы в колонках шапки',
    from_target: 'как в эталоне',
    revenue_osv_90: 'ОСВ 90 с номенклатурой',
    revenue_period: 'выручка по периодам',
    osv_flat_processed: 'плоская обработанная ОСВ',
    custom_rule: 'нетиповой формат → synth правило',
};

function buildScenarioCatalogCompact() {
    const extra = ['ks_card_composite_raw', 'ks_card_flat', 'revenue_osv_90', 'osv_flat_processed', 'custom_rule'];
    const ids = [...new Set([...Object.keys(SCENARIO_CATALOG), ...extra])];
    return ids.map((id) => ({
        id,
        name: SCENARIO_CATALOG[id]?.name || id,
        layoutType: SCENARIO_CATALOG[id]?.layoutType || null,
        hints: SCENARIO_CATALOG_HINTS[id] || '',
    }));
}

/**
 * @param {object} probeResult — из document_probe
 * @param {{ userMessage?: string }} opts
 */
function buildStructurePack(probeResult, opts = {}) {
    const { sourceKind, fileName, fingerprint, candidates, layoutMeta, pdfProbe, lines } = probeResult;
    const pack = {
        sourceKind,
        fileName,
        fingerprint,
        topCandidates: (candidates || []).slice(0, 3),
        userMessage: opts.userMessage || '',
    };

    if (sourceKind === 'excel' && layoutMeta) {
        pack.sheetName = layoutMeta.sheetName;
        pack.preview = layoutMeta.preview_tsv || layoutMeta.previewText || '';
        pack.columnCatalog = layoutMeta.column_catalog
            ? {
                  layout_type: layoutMeta.column_catalog.layout_type,
                  data_start_row: layoutMeta.column_catalog.data_start_row,
                  metrics: layoutMeta.column_catalog.metrics,
                  name_column: layoutMeta.column_catalog.name_column,
              }
            : null;
        pack.fingerprintReason = layoutMeta.recommended?.fingerprint_reason;
        if (layoutMeta.ontology) pack.ontology = layoutMeta.ontology;
        if (layoutMeta.classifier_ranked) pack.classifier_ranked = layoutMeta.classifier_ranked;
        if (layoutMeta.uk_probe) pack.uk_probe = layoutMeta.uk_probe;
    }

    if (sourceKind === 'pdf') {
        pack.pdfKind = pdfProbe?.kind;
        pack.pdfConfidence = pdfProbe?.confidence;
        pack.preview = numberedLines(lines, 0, 80);
        const tableStart = (lines || []).findIndex((l) => /А11а1б22а34567891010а111212а1314|—796шт/.test(l));
        if (tableStart >= 0) {
            pack.tableSample = numberedLines(lines, Math.max(0, tableStart - 5), 60);
        }
    }

    if (sourceKind === 'text_1c') {
        pack.preview = numberedLines(lines, 0, 60);
    }

    return pack;
}

/**
 * Обогащённый pack для LLM-router (Excel-лист).
 * @param {{ layoutMeta: object, data: Array, structure: object, sheetMeta?: object, file?: object, userMessage?: string }} ctx
 */
function buildExcelStructurePack(ctx, opts = {}) {
    const { layoutMeta, data, structure, sheetMeta, file } = ctx;
    const journal = detectJournalStructure(data || []);
    const ranked = scoreAllStructures(data || [], {
        hasOutline: sheetMeta?.hasOutline,
        rowOutlineLevels: sheetMeta?.rowOutlineLevels,
        mergedRanges: sheetMeta?.mergedRanges,
        layoutMeta,
    });
    const ontology = buildStructureOntology(data || [], {
        layoutMeta,
        structure,
        hasOutline: sheetMeta?.hasOutline,
        rowOutlineLevels: sheetMeta?.rowOutlineLevels,
        journal,
        ranked,
    });

    if (ontology.uk_probe) {
        layoutMeta.uk_probe = ontology.uk_probe;
    }
    layoutMeta.ontology = ontology;
    layoutMeta.classifier_ranked = ontology.classifier_ranked;

    const fingerprint =
        layoutMeta.layout_fingerprint ||
        buildLayoutFingerprint(data || [], {
            fileName: file?.originalname || layoutMeta.sourceFileName,
            sheetName: layoutMeta.sheetName,
        });

    const probeResult = {
        sourceKind: 'excel',
        fileName: file?.originalname || layoutMeta.sourceFileName || '',
        fingerprint,
        candidates: layoutMeta.candidates || [],
        layoutMeta,
    };

    const pack = buildStructurePack(probeResult, opts);
    pack.ontology = ontology;
    pack.classifier_ranked = ontology.classifier_ranked;
    pack.uk_probe = ontology.uk_probe;
    pack.scenario_catalog = buildScenarioCatalogCompact();
    pack.preview_rows = rowsToTsv(data, 0, 35);
    pack.fingerprintHash = fingerprintHash(fingerprint);
    pack.suggested_scenario = ontology.suggested_scenario;
    pack.structure_id = structure?.structure_id || ontology.suggested_structure_id;
    pack.structure_to_scenario = STRUCTURE_TO_SCENARIO;
    return pack;
}

function structurePackForLlm(pack) {
    return JSON.stringify(
        {
            sourceKind: pack.sourceKind,
            fileName: pack.fileName,
            sheetName: pack.sheetName,
            fingerprint: pack.fingerprint,
            topCandidates: pack.topCandidates,
            ontology: pack.ontology,
            classifier_ranked: pack.classifier_ranked,
            uk_probe: pack.uk_probe,
            scenario_catalog: pack.scenario_catalog,
            preview: String(pack.preview || pack.preview_rows || '').slice(0, 6000),
            preview_rows: pack.preview_rows ? String(pack.preview_rows).slice(0, 6000) : undefined,
            tableSample: pack.tableSample ? String(pack.tableSample).slice(0, 4000) : undefined,
            columnCatalog: pack.columnCatalog,
            userMessage: pack.userMessage,
        },
        null,
        2
    );
}

module.exports = {
    buildStructurePack,
    buildExcelStructurePack,
    buildScenarioCatalogCompact,
    structurePackForLlm,
    numberedLines,
    rowsToTsv,
};
