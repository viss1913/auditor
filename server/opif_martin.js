const { detectSourceKind } = require('./file_dispatch');
const { parseDepoFromBuffer } = require('./parse_depo');
const { parseBrokerFromBuffer, parseBroker } = require('./parse_broker');
const {
    resolveStructureFromMessage,
    extractFilePrefixFromText,
    extractBrokerSectionFromText,
    brokerSectionLabel,
} = require('./orchestrator/structure_resolve');
const { resolveBrokerSectionFromMessage } = require('./orchestrator/broker_section_resolve');
const { listSheetNames } = require('./excel_preview');
const { withTempFile } = require('./parse_preview');

const DEFAULT_BROKER_PREFIX = '1F018_';
/** Размер одной HTTP-пачки (multer), не лимит на весь парс папки */
const BROKER_UPLOAD_CHUNK = Math.min(
    500,
    Math.max(10, parseInt(process.env.BROKER_UPLOAD_CHUNK || '80', 10) || 80)
);
const MAX_BATCH_FILES = BROKER_UPLOAD_CHUNK;

const OPIF_SNAPSHOT_HEADERS = [
    'period',
    'operationType',
    'name',
    'regNum',
    'isin',
    'quantity',
    'amount',
    'currency',
    'registrationDate',
    'fee',
    'repo_percent',
    'exchange_trade_number',
    'debit_account',
    'depo_account',
    'credit_account',
    'source_file',
    'source_path',
];

function fileNameOf(file) {
    return file.originalname || file.name || '';
}

function relativePathOf(file) {
    return file.relativePath || file.webkitRelativePath || fileNameOf(file);
}

function extractFilePrefix(userMessage, explicitPrefix) {
    if (explicitPrefix) return String(explicitPrefix).trim();
    const struct = resolveStructureFromMessage(userMessage, {});
    if (struct.filePrefix) return struct.filePrefix;
    return extractFilePrefixFromText(userMessage);
}

function fileNameStartsWithPrefix(fileName, prefix) {
    const name = String(fileName || '');
    const p = String(prefix || '');
    if (!p) return false;
    return name.toLowerCase().startsWith(p.toLowerCase());
}

function isDepoIntent(userMessage, files) {
    const t = String(userMessage || '').toLowerCase();
    if (/депо|выписк|движени.*ценн/i.test(t)) return true;
    return files.some((f) => /(^|[\\/])depo([\\/]|$)/i.test(relativePathOf(f)));
}

function isBrokerPdfIntent(userMessage, files) {
    const t = String(userMessage || '').toLowerCase();
    if (/брокерск|отчет\s+брокер|aton|атон|client_\d+/i.test(t)) return true;
    const kinds = new Set(files.map((f) => detectSourceKind(fileNameOf(f))));
    if (!kinds.has('pdf') || kinds.has('excel')) return false;
    return files.some((f) => /client_\d+_\d{2}\.\d{2}\.\d{4}_to_/i.test(fileNameOf(f)));
}

function detectBatchScenario(files, userMessage, scenarioIdParam) {
    if (scenarioIdParam) return scenarioIdParam;

    const struct = resolveStructureFromMessage(userMessage, {});
    if (struct.scenarioId === 'broker_pdf') return 'broker_pdf';
    if (struct.scenarioId) return struct.scenarioId;

    const kinds = new Set(files.map((f) => detectSourceKind(fileNameOf(f))));

    if (isBrokerPdfIntent(userMessage, files)) return 'broker_pdf';

    const prefix = extractFilePrefix(userMessage) || DEFAULT_BROKER_PREFIX;
    const brokerHits = files.filter((f) => fileNameStartsWithPrefix(fileNameOf(f), prefix));
    if (brokerHits.length > 0 && kinds.has('excel')) return 'opif_broker';

    if (kinds.has('pdf') && isDepoIntent(userMessage, files)) return 'opif_depo';

    if (kinds.has('text_1c')) return 'card_90_tsv';
    if (kinds.has('excel')) return null;

    return null;
}

function filterFilesForScenario(files, scenarioId, userMessage, explicitPrefix) {
    if (scenarioId === 'opif_broker') {
        const prefix = extractFilePrefix(userMessage, explicitPrefix) || DEFAULT_BROKER_PREFIX;
        return files.filter((f) => {
            const name = fileNameOf(f);
            return fileNameStartsWithPrefix(name, prefix) && detectSourceKind(name) === 'excel';
        });
    }
    if (scenarioId === 'opif_depo') {
        return files.filter((f) => detectSourceKind(fileNameOf(f)) === 'pdf');
    }
    return files;
}

function probeFileList(fileMetas, userMessage = '') {
    const metas = Array.isArray(fileMetas) ? fileMetas : [];
    const pseudoFiles = metas.map((m) => ({
        originalname: m.name || m.fileName,
        name: m.name || m.fileName,
        relativePath: m.relativePath || m.source_path || '',
    }));

    const byKind = {};
    for (const f of pseudoFiles) {
        const kind = detectSourceKind(fileNameOf(f));
        byKind[kind] = (byKind[kind] || 0) + 1;
    }

    const prefix = extractFilePrefix(userMessage) || DEFAULT_BROKER_PREFIX;
    const prefixMatches = pseudoFiles.filter((f) =>
        fileNameStartsWithPrefix(fileNameOf(f), prefix)
    ).length;
    const suggestedScenario = detectBatchScenario(pseudoFiles, userMessage, null);

    return {
        fileCount: pseudoFiles.length,
        byKind,
        prefix,
        prefixMatches,
        suggestedScenario,
        sampleNames: pseudoFiles.slice(0, 5).map((f) => fileNameOf(f)),
        samplePaths: pseudoFiles.slice(0, 3).map((f) => relativePathOf(f)),
    };
}

async function probeUploadedFile(file, userMessage = '') {
    const name = fileNameOf(file);
    const kind = detectSourceKind(name);
    const base = probeFileList([{ name, relativePath: relativePathOf(file) }], userMessage);

    let sheetNames = [];
    if (kind === 'excel' && file.buffer) {
        try {
            sheetNames = listSheetNames(file.buffer).sheetNames || [];
        } catch {
            sheetNames = [];
        }
    }

    let groups = null;
    if (file.buffer) {
        try {
            const { groupFilesByStructure, serializeGroupsForClient } = require('./universal_parse/file_group_resolver');
            groups = serializeGroupsForClient(await groupFilesByStructure([file]));
        } catch {
            groups = null;
        }
    }

    return {
        ...base,
        sourceKind: kind,
        fileName: name,
        sheetNames,
        groups,
    };
}

async function probeFilesWithGroups(files, userMessage = '') {
    const list = Array.isArray(files) ? files : [];
    const metas = list.map((f) => ({
        name: fileNameOf(f),
        relativePath: relativePathOf(f),
    }));
    const base = probeFileList(metas, userMessage);

    const withBuffer = list.filter((f) => f.buffer);
    if (!withBuffer.length) {
        return { ...base, groups: [] };
    }

    try {
        const { groupFilesByStructure, serializeGroupsForClient } = require('./universal_parse/file_group_resolver');
        const groups = serializeGroupsForClient(await groupFilesByStructure(withBuffer));
        return { ...base, groups };
    } catch {
        return { ...base, groups: [] };
    }
}

function attachSourceMeta(rows, file) {
    const sourceFile = fileNameOf(file);
    const sourcePath = relativePathOf(file);
    return rows.map((row) => ({
        ...row,
        source_file: sourceFile,
        source_path: sourcePath,
    }));
}

function resolveBrokerSection(userMessage, explicitSection) {
    if (explicitSection === '1.1' || explicitSection === '1.2') return explicitSection;
    const fromMsg = extractBrokerSectionFromText(userMessage);
    if (fromMsg) return fromMsg;
    return resolveBrokerSectionFromMessage(userMessage).brokerSection;
}

async function parseOpifFile(file, scenarioId, options = {}) {
    const name = fileNameOf(file);
    const fromPath = file.absolutePath;

    if (scenarioId === 'opif_depo') {
        if (fromPath) {
            const { parseDepo } = require('./parse_depo');
            const rows = await parseDepo(fromPath, name);
            return attachSourceMeta(rows, file);
        }
        const buffer = file.buffer;
        if (!buffer) throw new Error(`Нет buffer для ${name}`);
        const rows = await parseDepoFromBuffer(buffer, name);
        return attachSourceMeta(rows, file);
    }

    if (scenarioId === 'opif_broker') {
        const brokerOpts = { sectionId: resolveBrokerSection('', options.brokerSection) };
        if (fromPath) {
            return attachSourceMeta(parseBroker(fromPath, brokerOpts), file);
        }
        if (!file.buffer) throw new Error(`Нет buffer для ${name}`);
        const rows = await parseBrokerFromBuffer(file.buffer, brokerOpts);
        return attachSourceMeta(rows, file);
    }

    throw new Error(`Неизвестный OPIF сценарий: ${scenarioId}`);
}

async function parseOpifBatch(files, scenarioId, userMessage, explicitPrefix, brokerSection) {
    const filtered = filterFilesForScenario(files, scenarioId, userMessage, explicitPrefix);
    const sectionId = resolveBrokerSection(userMessage, brokerSection);
    const sectionTitle = brokerSectionLabel(sectionId);
    if (!filtered.length) {
        return {
            ok: false,
            errors: [`Нет файлов после фильтра для сценария ${scenarioId}`],
            rows: [],
            warnings: [],
            filesProcessed: 0,
            brokerSection: sectionId,
        };
    }

    const allRows = [];
    const warnings = [];

    for (const file of filtered) {
        try {
            const rows = await parseOpifFile(file, scenarioId, { brokerSection: sectionId });
            allRows.push(...rows);
            if (!rows.length) {
                warnings.push(`Файл ${fileNameOf(file)}: раздел «${sectionTitle}» — строк 0`);
            }
        } catch (e) {
            warnings.push(`Файл ${fileNameOf(file)}: ${e.message}`);
        }
    }

    return {
        ok: allRows.length > 0 || warnings.length < filtered.length,
        rows: allRows,
        headers: OPIF_SNAPSHOT_HEADERS,
        warnings,
        filesProcessed: filtered.length,
        filesMatched: filtered.length,
        scenarioId,
        brokerSection: sectionId,
    };
}

function buildOpifAssistantMessage(scenarioId, stats) {
    const name = scenarioId === 'opif_depo' ? 'выписки ДЕПО (PDF)' : 'отчёты брокера';
    const fileNote =
        stats.filesMatched != null && stats.filesMatched !== stats.filesProcessed
            ? `**${stats.filesProcessed}** файл(ов) из **${stats.filesMatched}** с префиксом`
            : `**${stats.filesProcessed}** файл(ов)`;
    const lines = [`Разобрала **${name}**: ${fileNote}, **${stats.rowCount}** строк в одной таблице.`];
    if (stats.prefix) lines.push(`Префикс файлов: \`${stats.prefix}\`.`);
    if (stats.brokerSection) lines.push(`Раздел Excel: **${brokerSectionLabel(stats.brokerSection)}**.`);
    if (stats.warnings?.length) {
        lines.push('', 'Предупреждения:', ...stats.warnings.slice(0, 5).map((w) => `• ${w}`));
    }
    return lines.join('\n');
}

function isOpifScenario(scenarioId) {
    return scenarioId === 'opif_depo' || scenarioId === 'opif_broker';
}

module.exports = {
    DEFAULT_BROKER_PREFIX,
    BROKER_UPLOAD_CHUNK,
    MAX_BATCH_FILES,
    OPIF_SNAPSHOT_HEADERS,
    extractFilePrefix,
    resolveBrokerSection,
    detectBatchScenario,
    filterFilesForScenario,
    probeFileList,
    probeUploadedFile,
    probeFilesWithGroups,
    parseOpifBatch,
    parseOpifFile,
    buildOpifAssistantMessage,
    isOpifScenario,
    fileNameOf,
    relativePathOf,
};
