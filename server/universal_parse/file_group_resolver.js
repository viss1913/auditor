const { detectSourceKind } = require('../file_dispatch');
const { analyzeLayout } = require('../analyze_layout');
const { pickPreferredSheet } = require('../excel_sheet_meta');
const { listSheetNames } = require('../excel_preview');
const { probePdfKind } = require('../pdf_probe');
const { fingerprintHash } = require('./rule_cache');
const {
    buildStructuralFingerprint,
    headerSimilarity,
    getPdfPageMetrics,
} = require('./pdf_structural_fingerprint');

const MERGE_SIMILARITY_THRESHOLD = 0.72;

function fileNameOf(file) {
    return file.originalname || file.name || '';
}

function extractExcelSampleHeaders(layoutMeta) {
    const catalog = layoutMeta?.column_catalog;
    if (catalog?.metrics?.length) {
        return catalog.metrics
            .slice(0, 6)
            .map((m) => m.header_label || m.suggested_measure || m.letter || '')
            .filter(Boolean);
    }
    const flatDim = layoutMeta?.layout_fingerprint?.flatDim;
    if (flatDim?.headerRow != null && layoutMeta?.previewText) {
        const row = layoutMeta.previewText.split('\n')[flatDim.headerRow];
        if (row) {
            return row
                .split('\t')
                .map((c) => String(c || '').trim())
                .filter((c) => c && c.length < 80)
                .slice(0, 6);
        }
    }
    const hint = layoutMeta?.recommended?.profile_hint || layoutMeta?.recommended?.description;
    return hint ? [String(hint)] : [];
}

function buildExcelStructureKey(layoutMeta) {
    const rec = layoutMeta?.recommended || {};
    const metrics = (layoutMeta?.column_catalog?.metrics || [])
        .slice(0, 5)
        .map((m) => m.suggested_measure || m.header_label || m.letter)
        .filter(Boolean);
    return fingerprintHash({
        kind: 'excel',
        layoutType: rec.layout_type || layoutMeta?.column_catalog?.layout_type || '',
        profileHint: rec.profile_hint || '',
        metrics,
        sheetName: layoutMeta?.sheetName || '',
    });
}

function buildExcelGroupLabel(layoutMeta, fileName) {
    const rec = layoutMeta?.recommended;
    if (rec?.description) return rec.description;
    if (rec?.profile_hint) return `Excel · ${rec.profile_hint}`;
    return `Excel · ${fileName}`;
}

async function probeExcelStructure(file) {
    const name = fileNameOf(file);
    const buffer = file.buffer;
    if (!buffer) {
        return {
            key: `excel:no-buffer:${name}`,
            label: `Excel · ${name}`,
            kind: 'excel',
            sampleHeaders: [],
            signals: {},
        };
    }

    let sheetName = null;
    try {
        const { sheetNames } = listSheetNames(buffer);
        sheetName = pickPreferredSheet(sheetNames);
    } catch {
        sheetName = null;
    }

    const layoutMeta = analyzeLayout(buffer, sheetName, { fileName: name });
    const sampleHeaders = extractExcelSampleHeaders(layoutMeta);
    return {
        key: buildExcelStructureKey(layoutMeta),
        label: buildExcelGroupLabel(layoutMeta, name),
        kind: 'excel',
        sampleHeaders,
        signals: {
            headerSample: sampleHeaders,
            layoutMeta,
        },
    };
}

async function probePdfStructure(file) {
    const name = fileNameOf(file);
    const buffer = file.buffer;
    if (!buffer) {
        return {
            key: `pdf:no-buffer:${name}`,
            label: `PDF · ${name}`,
            kind: 'pdf',
            sampleHeaders: [],
            signals: {},
        };
    }

    const pdfProbe = await probePdfKind(buffer, name);
    let pageWidthPt = 595;
    try {
        const metrics = await getPdfPageMetrics(buffer, 1);
        pageWidthPt = metrics.pageWidthPt || pageWidthPt;
    } catch {
        /* ignore */
    }

    const lines = (pdfProbe.lines || []).slice(0, 40);
    const headerSample = lines
        .filter((l) => l && l.length > 2 && l.length < 80)
        .slice(0, 3);

    const key = buildStructuralFingerprint({
        docKind: pdfProbe.kind,
        brokerSubtype: pdfProbe.brokerSubtype,
        columnCount: headerSample.length || 0,
        pageWidthPt,
        headerSample,
    });

    const kindLabels = {
        broker_report: 'Брокерский отчёт',
        depo: 'Депозитарная выписка',
        upd_ediweb: 'УПД',
        unknown: 'PDF',
    };

    return {
        key,
        label: `${kindLabels[pdfProbe.kind] || 'PDF'} · ${pdfProbe.kind}`,
        kind: 'pdf',
        sampleHeaders: headerSample,
        signals: {
            headerSample,
            docKind: pdfProbe.kind,
            pageWidthPt,
        },
    };
}

async function probeFileStructure(file) {
    const name = fileNameOf(file);
    const kind = detectSourceKind(name);

    if (kind === 'excel') return probeExcelStructure(file);
    if (kind === 'pdf' || kind === 'image_scan') return probePdfStructure(file);

    return {
        key: `kind:${kind}:${name}`,
        label: `${kind} · ${name}`,
        kind,
        sampleHeaders: [],
        signals: {},
    };
}

function areStructuresSimilar(a, b) {
    if (!a || !b) return false;
    if (a.key === b.key) return true;
    if (a.kind !== b.kind) return false;

    const sim = headerSimilarity(a.sampleHeaders, b.sampleHeaders);
    if (sim >= MERGE_SIMILARITY_THRESHOLD) return true;

    if (a.kind === 'excel' && b.kind === 'excel') {
        const la = a.signals?.layoutMeta?.recommended?.profile_hint;
        const lb = b.signals?.layoutMeta?.recommended?.profile_hint;
        if (la && lb && la === lb) return true;
    }

    if (a.kind === 'pdf' && b.kind === 'pdf') {
        const da = a.signals?.docKind;
        const db = b.signals?.docKind;
        if (da && db && da === db && da !== 'unknown') return true;
    }

    return false;
}

/**
 * @param {Array<{ buffer?, originalname?, name?, relativePath? }>} files
 * @returns {Promise<Array<{ key, label, kind, sampleHeaders, files }>>}
 */
async function groupFilesByStructure(files) {
    const list = Array.isArray(files) ? files : [];
    if (!list.length) return [];

    const probes = [];
    for (const file of list) {
        const structure = await probeFileStructure(file);
        probes.push({ file, structure });
    }

    const groups = [];
    for (const { file, structure } of probes) {
        let target = null;
        for (const g of groups) {
            if (areStructuresSimilar(g.representative, structure)) {
                target = g;
                break;
            }
        }
        if (target) {
            target.files.push(file);
            if (!target.sampleHeaders?.length && structure.sampleHeaders?.length) {
                target.sampleHeaders = structure.sampleHeaders;
            }
        } else {
            groups.push({
                key: structure.key,
                label: structure.label,
                kind: structure.kind,
                sampleHeaders: structure.sampleHeaders || [],
                files: [file],
                representative: structure,
            });
        }
    }

    return groups.map((g, idx) => ({
        key: g.key,
        label: g.label || `Группа ${idx + 1}`,
        kind: g.kind,
        sampleHeaders: g.sampleHeaders || [],
        files: g.files,
        fileCount: g.files.length,
        sampleNames: g.files.slice(0, 4).map(fileNameOf),
    }));
}

function buildMergeStrategyQuestion(groups) {
    const summary = (groups || [])
        .map((g, i) => {
            const hdr =
                g.sampleHeaders?.length > 0
                    ? g.sampleHeaders.slice(0, 3).join(', ')
                    : g.label;
            return `**${i + 1}.** ${g.fileCount} файл(ов) — ${hdr}`;
        })
        .join('\n');

    return {
        id: 'pick_merge_strategy',
        promptTemplate:
            `Вижу **${groups.length}** разных структур в пачке:\n\n${summary}\n\n` +
            'Как собрать результат?',
        options: [
            {
                value: 'one_table',
                label: 'Одна общая таблица (все файлы, колонка source_file)',
            },
            {
                value: 'by_group',
                label: 'По структуре — отдельная таблица на каждую группу',
            },
            {
                value: 'per_file',
                label: 'По файлам — каждый файл в свою таблицу',
            },
        ],
        groups: groups.map((g) => ({
            key: g.key,
            label: g.label,
            kind: g.kind,
            fileCount: g.fileCount,
            sampleHeaders: g.sampleHeaders,
            sampleNames: g.sampleNames,
        })),
    };
}

function normalizeHeaderList(headers) {
    return (headers || []).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
}

function headersCompatible(existingHeaders, newHeaders, { ignoreSourceFile = true } = {}) {
    const skip = new Set(['source_file', 'source_path', '№']);
    if (ignoreSourceFile) {
        skip.add('source_file');
        skip.add('source_path');
    }
    const a = normalizeHeaderList(existingHeaders).filter((h) => !skip.has(h));
    const b = normalizeHeaderList(newHeaders).filter((h) => !skip.has(h));
    if (!a.length || !b.length) return { ok: true, warning: null };
    if (a.length !== b.length) {
        return {
            ok: false,
            warning: `Колонок ${b.length}, в таблице ${a.length}. Проверь структуру.`,
        };
    }
    const mismatches = a.filter((h, i) => h !== b[i]);
    if (mismatches.length) {
        return {
            ok: false,
            warning: `Заголовки не совпадают: ${mismatches.slice(0, 3).join(', ')}`,
        };
    }
    return { ok: true, warning: null };
}

function serializeGroupsForClient(groups) {
    return (groups || []).map((g) => ({
        key: g.key,
        label: g.label,
        kind: g.kind,
        fileCount: g.fileCount || g.files?.length || 0,
        sampleHeaders: g.sampleHeaders || [],
        sampleNames: g.sampleNames || (g.files || []).slice(0, 4).map(fileNameOf),
    }));
}

module.exports = {
    groupFilesByStructure,
    buildMergeStrategyQuestion,
    headersCompatible,
    probeFileStructure,
    serializeGroupsForClient,
    fileNameOf,
};
