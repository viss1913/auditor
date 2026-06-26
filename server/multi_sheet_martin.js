const { detectSourceKind } = require('./file_dispatch');
const { listSheetNames } = require('./excel_preview');
const { isMetaSheetName } = require('./excel_sheet_meta');
const { loadTargetRows } = require('./compare_target');
const {
    orchestrateSheetParse,
    isInstructionSheet,
    isReferenceSheet,
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
        const refused = skipped.filter((s) => s.refused);
        const other = skipped.filter((s) => !s.refused);
        if (refused.length) {
            lines.push(`Не разобрала ${refused.length} лист(а) — формат неизвестен или неуверен:`);
            for (const s of refused) {
                lines.push(s.assistantMessage || `«${s.sheetName}»: ${s.reason}`);
            }
        }
        if (other.length) {
            lines.push(
                `Пропустила ${other.length} лист(а): ${other.map((s) => `«${s.sheetName}» (${s.reason})`).join('; ')}`
            );
        }
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

/** Авто multi-sheet на гигантских xlsx — десятки минут; только по явной фразе «все листы». */
const MULTI_SHEET_MAX_BYTES = 6 * 1024 * 1024;

function shouldParseAllSheets({ files, scenarioId, parseAllSheets, orchestratorAnswers, sheetName }) {
    if (parseAllSheets === '0' || parseAllSheets === false) return false;
    if (scenarioId && /opif_|deals_|card_90/.test(scenarioId)) return false;
    const explicit = isExplicitParseAllSheets(parseAllSheets);
    if (!files?.length || files.length !== 1) return false;
    const fileBytes = files[0].buffer?.length || 0;
    if (!explicit && fileBytes > MULTI_SHEET_MAX_BYTES) return false;
    const name = files[0].originalname || files[0].name || '';
    if (detectSourceKind(name) !== 'excel') return false;
    const { sheetNames, defaultSheet } = listSheetNames(files[0].buffer);
    if (explicit) return sheetNames.length >= 1;
    // defaultSheet в body ≠ явный выбор одного листа
    if (
        sheetNames.length > 1 &&
        sheetName &&
        sheetName === defaultSheet &&
        !orchestratorAnswers?.sheetName
    ) {
        return true;
    }
    if (!explicit && wantsSingleSheetOnly(orchestratorAnswers, sheetName)) return false;
    return sheetNames.length > 1;
}

async function parseOneExcelSheet(opts) {
    return orchestrateSheetParse(opts);
}

function wantsMultiSheetExcelParse({
    files,
    sheetNames = [],
    scenarioId,
    parseAllSheets,
    orchestratorAnswers,
    sheetName,
    parsePlan,
}) {
    return (
        parsePlan?.parseAllSheets ||
        shouldParseAllSheets({
            files,
            scenarioId,
            parseAllSheets,
            orchestratorAnswers,
            sheetName,
        }) ||
        (sheetNames.length > 1 &&
            !sheetName &&
            !orchestratorAnswers?.sheetName &&
            !String(orchestratorAnswers?.pick_tree_flatten || '').startsWith('scenario:') &&
            !scenarioId)
    );
}

async function parseAllExcelSheets({ pool, file, targetFile, projectId, savedRules = [], userMessage = '' }) {
    const { sheetNames } = listSheetNames(file.buffer);
    const target = targetFile?.buffer ? loadTargetRows(targetFile.buffer) : null;
    const parsed = [];
    const skipped = [];
    const allWarnings = [];

    for (const sheetName of sheetNames) {
        if (isMetaSheetName(sheetName)) {
            skipped.push({
                ok: false,
                sheetName,
                skipped: true,
                reason: 'служебный лист (мэппинг/выводы)',
            });
            continue;
        }
        try {
            const result = await orchestrateSheetParse({
                pool,
                file,
                sheetName,
                projectId,
                savedRules,
                target,
                userMessage,
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
    wantsMultiSheetExcelParse,
    parseAllExcelSheets,
    parseOneExcelSheet,
    isInstructionSheet,
    isReferenceSheet,
    isPlausibleParse,
    scenarioCandidatesForLayout,
    buildMultiSheetAssistantMessage,
};
