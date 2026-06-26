const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const {
    probeExcelBuffer,
    probeExcelFile,
    canProbeExtension,
} = require('./excel_probe_bridge');

/** openpyxl-probe на крупных xlsx — минуты; для classify/journal хватает SheetJS */
const PROBE_MAX_BYTES = 4 * 1024 * 1024;
/** cellStyles на файлах >8 МБ — минуты RAM/CPU; outline для UK на таких размерах редко нужен */
const CELL_STYLES_MAX_BYTES = 8 * 1024 * 1024;

function shouldUseExcelProbe(source, explicit) {
    if (explicit === false) return false;
    if (explicit === true) return true;
    const buf = Buffer.isBuffer(source) ? source : null;
    if (!buf) return true;
    return buf.length <= PROBE_MAX_BYTES;
}

function readWorkbook(source) {
    const buf = Buffer.isBuffer(source) ? source : null;
    const useStyles = !buf || buf.length <= CELL_STYLES_MAX_BYTES;
    const readOpts = useStyles ? { cellStyles: true } : {};
    if (Buffer.isBuffer(source)) {
        return xlsx.read(source, { type: 'buffer', ...readOpts });
    }
    return xlsx.readFile(source, readOpts);
}

/** Служебные вкладки 1С/аудита — не данные для парса */
function isMetaSheetName(sheetName) {
    const s = String(sheetName || '').trim();
    if (!s) return true;
    if (/^(выводы|пояснен|задание|титул|содержание|readme|инструкц|процедур)/i.test(s)) {
        return true;
    }
    // Эталон/мэппинг и сводные листы ТЗ — не исходные данные для парса
    if (/мэппинг|mapping/i.test(s)) return true;
    if (/результат\s+для\s+отч/i.test(s)) return true;
    return false;
}

function isLikelyDataSheetName(sheetName) {
    const s = String(sheetName || '').trim();
    if (!s || isMetaSheetName(s)) return false;
    if (/^(TDSheet|Лист\d*)$/i.test(s)) return true;
    if (/исходн|осв|кс|рд_|карт|обработ/i.test(s)) return true;
    return true;
}

/** Предпочитаем «Исходная ОСВ», не «Исходная КС»; пропускаем «Выводы» и пр. */
function pickPreferredSheet(sheetNames, explicit) {
    const names = sheetNames || [];
    if (explicit && names.includes(explicit)) return explicit;

    const dataSheets = names.filter(isLikelyDataSheetName);
    const pool = dataSheets.length ? dataSheets : names;

    return (
        pool.find((s) => /исходн.*выгрузк/i.test(s)) ||
        pool.find((s) => /исходн.*осв/i.test(s)) ||
        pool.find((s) => /исходн/i.test(s) && !/кс/i.test(s) && !/мэппинг|mapping/i.test(s)) ||
        pool.find((s) => /осв/i.test(s) && !/кс/i.test(s)) ||
        pool.find((s) => /^TDSheet$/i.test(s)) ||
        pool.find((s) => /^лист\d*$/i.test(s)) ||
        pool.find((s) => /^рд_/i.test(s)) ||
        pool.find((s) => /исходн/i.test(s)) ||
        pool.find((s) => /карт/i.test(s)) ||
        pool[0] ||
        null
    );
}

function pickSheetName(workbook, sheetName) {
    const sheetNames = workbook.SheetNames || [];
    return pickPreferredSheet(sheetNames, sheetName);
}

/**
 * Уровни группировки строк Excel (outline) — то, что видно слева с «−».
 * SheetJS кладёт их в worksheet['!rows'][i].level при чтении xlsx.
 */
function extractRowOutlineLevels(worksheet, rowCount = 0) {
    const rowMeta = worksheet['!rows'] || [];
    const maxLen = Math.max(rowCount, rowMeta.length);
    const levels = new Array(maxLen).fill(0);
    let hasOutline = false;

    for (let i = 0; i < rowMeta.length; i++) {
        const r = rowMeta[i];
        if (!r) continue;
        const lvl = Number(r.level ?? r.outlineLevel ?? 0) || 0;
        if (lvl > 0) hasOutline = true;
        levels[i] = lvl;
    }

    return { rowOutlineLevels: levels, hasOutline };
}

function normalizeLabel(raw) {
    const s = String(raw ?? '').replace(/\u00A0/g, ' ');
    const text = s.trim();
    const leading = s.length - s.trimStart().length;
    const indentDepth = leading > 0 ? Math.max(1, Math.ceil(leading / 2)) : 0;
    return { text, indentDepth, raw: s };
}

function colLettersToIndex(letters) {
    let n = 0;
    for (const ch of letters) {
        n = n * 26 + (ch.charCodeAt(0) - 64);
    }
    return n - 1;
}

function parseCellRef(ref) {
    const m = /^([A-Z]+)(\d+)$/i.exec(String(ref || '').trim());
    if (!m) return null;
    return { col: colLettersToIndex(m[1].toUpperCase()), row: Number(m[2]) - 1 };
}

/**
 * Размазывает значение верхней-левой ячейки мержа по всему диапазону.
 * @param {Array<Array>} data
 * @param {string[]} mergedRanges — A1-нотация, напр. "A5:C5"
 */
function expandMergedCells(data, mergedRanges) {
    if (!Array.isArray(mergedRanges) || !mergedRanges.length) return data;
    const out = data.map((row) => (Array.isArray(row) ? [...row] : []));

    for (const range of mergedRanges) {
        const parts = String(range).split(':');
        const start = parseCellRef(parts[0]);
        const end = parseCellRef(parts[1] || parts[0]);
        if (!start || !end) continue;

        const value = out[start.row]?.[start.col];
        if (value === undefined || value === null || value === '') continue;

        for (let r = start.row; r <= end.row; r++) {
            if (!out[r]) out[r] = [];
            for (let c = start.col; c <= end.col; c++) {
                if (out[r][c] === undefined || out[r][c] === null || out[r][c] === '') {
                    out[r][c] = value;
                }
            }
        }
    }

    return out;
}

function resolveProbe(source, sheetName, options = {}) {
    if (options.probe) return options.probe;
    if (!options.useExcelProbe) return null;

    if (Buffer.isBuffer(source)) {
        const fileName = options.fileName || 'probe.xlsx';
        return probeExcelBuffer(source, sheetName, fileName);
    }

    if (typeof source === 'string' && canProbeExtension(source)) {
        return probeExcelFile(source, sheetName);
    }

    return null;
}

function applyProbeMeta({ data, rowOutlineLevels, hasOutline }, probe) {
    if (!probe?.ok) {
        return {
            data,
            rowOutlineLevels,
            hasOutline,
            probe: null,
            styleHints: null,
            rowMeta: [],
            mergedRanges: [],
            hiddenRowIndices: [],
            skipRowIndices: [],
        };
    }

    let nextData = data;
    if (probe.merged_ranges?.length) {
        nextData = expandMergedCells(data, probe.merged_ranges);
    }

    let nextOutline = rowOutlineLevels;
    let nextHasOutline = hasOutline;
    if (Array.isArray(probe.row_outline_levels) && probe.row_outline_levels.length) {
        nextOutline = probe.row_outline_levels;
        nextHasOutline = Boolean(probe.has_outline);
    }

    const styleHints = probe.style_hints || null;
    const hiddenRowIndices = styleHints?.hidden_rows || [];
    const skipRowIndices = styleHints?.likely_subtotal_rows || [];

    return {
        data: nextData,
        rowOutlineLevels: nextOutline,
        hasOutline: nextHasOutline,
        probe,
        styleHints,
        rowMeta: probe.row_meta || [],
        mergedRanges: probe.merged_ranges || [],
        hiddenRowIndices,
        skipRowIndices,
    };
}

/**
 * @param {Buffer|string} source
 * @param {string} [sheetName]
 * @param {{ probe?: object, useExcelProbe?: boolean, fileName?: string }} [options]
 */
function readSheetWithMeta(source, sheetName, options = {}) {
    const buffer = Buffer.isBuffer(source)
        ? source
        : typeof source === 'string'
          ? fs.readFileSync(source)
          : null;

    const fileName =
        options.fileName ||
        (typeof source === 'string' ? path.basename(source) : 'probe.xlsx');

    const useExcelProbe = shouldUseExcelProbe(buffer || source, options.useExcelProbe);

    const probe = resolveProbe(buffer || source, sheetName, {
        ...options,
        useExcelProbe,
        fileName,
    });

    const workbook = readWorkbook(buffer || source);
    const sheetNames = workbook.SheetNames || [];
    const usedSheet = pickSheetName(workbook, sheetName);
    const worksheet = workbook.Sheets[usedSheet];
    let data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
    const { rowOutlineLevels, hasOutline } = extractRowOutlineLevels(worksheet, data.length);
    const enriched = applyProbeMeta({ data, rowOutlineLevels, hasOutline }, probe);

    return {
        workbook,
        worksheet,
        data: enriched.data,
        sheetNames,
        sheetName: usedSheet,
        rowOutlineLevels: enriched.rowOutlineLevels,
        hasOutline: enriched.hasOutline,
        excelProbe: enriched.probe,
        styleHints: enriched.styleHints,
        rowMeta: enriched.rowMeta,
        mergedRanges: enriched.mergedRanges,
        hiddenRowIndices: enriched.hiddenRowIndices,
        skipRowIndices: enriched.skipRowIndices,
    };
}

/** Снимок листа в памяти — переиспользуем между preview и import (без повторного xlsx.read). */
function sheetLoadFromMeta(loaded) {
    if (!loaded) return null;
    return {
        data: loaded.data || [],
        sheetName: loaded.sheetName,
        rowOutlineLevels: loaded.rowOutlineLevels,
        hasOutline: loaded.hasOutline,
        styleHints: loaded.styleHints,
        skipRowIndices: loaded.skipRowIndices,
        hiddenRowIndices: loaded.hiddenRowIndices,
        excelProbe: loaded.excelProbe,
    };
}

module.exports = {
    PROBE_MAX_BYTES,
    shouldUseExcelProbe,
    sheetLoadFromMeta,
    isMetaSheetName,
    isLikelyDataSheetName,
    readWorkbook,
    readSheetWithMeta,
    extractRowOutlineLevels,
    normalizeLabel,
    pickSheetName,
    pickPreferredSheet,
    expandMergedCells,
    applyProbeMeta,
};
