const { detectSourceKind } = require('./file_dispatch');
const { listSheetNames } = require('./excel_preview');
const { loadTargetRows } = require('./compare_target');
const {
    orchestrateSheetParse,
    isInstructionSheet,
    isPlausibleParse,
    scenarioCandidatesForLayout,
} = require('./sheet_parse_orchestrator');

function buildMultiSheetAssistantMessage(fileName, parsed, skipped) {
    const lines = [`Разобрала **${parsed.length}** лист(а) из «${fileName}»:`];
    for (const p of parsed) {
        lines.push(`• **${p.sheetName}** — ${p.rowCount.toLocaleString('ru-RU')} строк (${p.scenarioName})`);
    }
    if (skipped.length) {
        lines.push('');
        lines.push(`Пропустила ${skipped.length} лист(а): ${skipped.map((s) => `«${s.sheetName}» (${s.reason})`).join('; ')}`);
    }
    lines.push('');
    lines.push('Переключай вкладки сверху — команды в чате идут в **активную** таблицу. Лишние вкладки можно убрать крестиком ×.');
    return lines.join('\n');
}

function isExplicitParseAllSheets(parseAllSheets) {
    return (
        parseAllSheets === '1' ||
        parseAllSheets === 1 ||
        parseAllSheets === true ||
        parseAllSheets === 'true'
    );
}

function wantsSingleSheetOnly(orchestratorAnswers, sheetName) {
    if (sheetName) return true;
    if (orchestratorAnswers?.sheetName) return true;
    const treePick = orchestratorAnswers?.pick_tree_flatten;
    if (treePick && treePick !== 'confirm') return true;
    if (String(treePick || '').startsWith('scenario:')) return true;
    return false;
}

function shouldParseAllSheets({ files, scenarioId, parseAllSheets, orchestratorAnswers, sheetName }) {
    if (parseAllSheets === '0' || parseAllSheets === false) return false;
    if (scenarioId && /opif_|deals_|card_90/.test(scenarioId)) return false;
    const explicit = isExplicitParseAllSheets(parseAllSheets);
    if (!explicit && wantsSingleSheetOnly(orchestratorAnswers, sheetName)) return false;
    if (!files?.length || files.length !== 1) return false;
    const name = files[0].originalname || files[0].name || '';
    if (detectSourceKind(name) !== 'excel') return false;
    const { sheetNames } = listSheetNames(files[0].buffer);
    if (explicit) return sheetNames.length >= 1;
    return sheetNames.length > 1;
}

async function parseOneExcelSheet(opts) {
    return orchestrateSheetParse(opts);
}

async function parseAllExcelSheets({ pool, file, targetFile, projectId, savedRules = [] }) {
    const { sheetNames } = listSheetNames(file.buffer);
    const target = targetFile?.buffer ? loadTargetRows(targetFile.buffer) : null;
    const parsed = [];
    const skipped = [];
    const allWarnings = [];

    for (const sheetName of sheetNames) {
        try {
            const result = await orchestrateSheetParse({
                pool,
                file,
                sheetName,
                projectId,
                savedRules,
                target,
            });
            if (result.ok) {
                parsed.push(result);
                if (result.warnings?.length) allWarnings.push(...result.warnings);
            } else {
                skipped.push(result);
            }
        } catch (err) {
            skipped.push({ ok: false, sheetName, skipped: true, reason: err.message });
        }
    }

    const assistantMessage = buildMultiSheetAssistantMessage(
        file.originalname || file.name || 'файл',
        parsed,
        skipped
    );

    return {
        ok: parsed.length > 0,
        sheetNames,
        parsed,
        skipped,
        warnings: allWarnings,
        assistantMessage,
        primary: parsed[0] || null,
    };
}

module.exports = {
    isExplicitParseAllSheets,
    wantsSingleSheetOnly,
    shouldParseAllSheets,
    parseAllExcelSheets,
    parseOneExcelSheet,
    isInstructionSheet,
    isPlausibleParse,
    scenarioCandidatesForLayout,
    buildMultiSheetAssistantMessage,
};
