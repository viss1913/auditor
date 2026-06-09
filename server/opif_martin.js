const { detectSourceKind } = require('./file_dispatch');
const { parseDepoFromBuffer } = require('./parse_depo');
const { parseBrokerFromBuffer } = require('./parse_broker');
const {
    resolveStructureFromMessage,
    extractFilePrefixFromText,
} = require('./orchestrator/structure_resolve');
const { listSheetNames } = require('./excel_preview');
const { withTempFile } = require('./parse_preview');

const DEFAULT_BROKER_PREFIX = '1F018_';
const MAX_BATCH_FILES = 200;

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
    'debit_account',
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

function detectBatchScenario(files, userMessage, scenarioIdParam) {
    if (scenarioIdParam) return scenarioIdParam;

    const struct = resolveStructureFromMessage(userMessage, {});
    if (struct.scenarioId) return struct.scenarioId;

    const kinds = new Set(files.map((f) => detectSourceKind(fileNameOf(f))));
    if (kinds.has('pdf')) return 'opif_depo';

    const prefix = extractFilePrefix(userMessage) || DEFAULT_BROKER_PREFIX;
    const brokerHits = files.filter((f) => fileNameStartsWithPrefix(fileNameOf(f), prefix));
    if (brokerHits.length > 0) return 'opif_broker';

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

    return {
        ...base,
        sourceKind: kind,
        fileName: name,
        sheetNames,
    };
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

async function parseOpifFile(file, scenarioId) {
    const name = fileNameOf(file);
    const buffer = file.buffer;
    if (!buffer) throw new Error(`Нет buffer для ${name}`);

    if (scenarioId === 'opif_depo') {
        const rows = await parseDepoFromBuffer(buffer, name);
        return attachSourceMeta(rows, file);
    }

    if (scenarioId === 'opif_broker') {
        const rows = parseBrokerFromBuffer(buffer);
        return attachSourceMeta(rows, file);
    }

    throw new Error(`Неизвестный OPIF сценарий: ${scenarioId}`);
}

async function parseOpifBatch(files, scenarioId, userMessage, explicitPrefix) {
    const filtered = filterFilesForScenario(files, scenarioId, userMessage, explicitPrefix);
    if (!filtered.length) {
        return {
            ok: false,
            errors: [`Нет файлов после фильтра для сценария ${scenarioId}`],
            rows: [],
            warnings: [],
            filesProcessed: 0,
        };
    }

    const allRows = [];
    const warnings = [];

    for (const file of filtered.slice(0, MAX_BATCH_FILES)) {
        try {
            const rows = await parseOpifFile(file, scenarioId);
            allRows.push(...rows);
            if (!rows.length) {
                warnings.push(`Файл ${fileNameOf(file)}: строк не найдено`);
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
        scenarioId,
    };
}

function buildOpifAssistantMessage(scenarioId, stats) {
    const name = scenarioId === 'opif_depo' ? 'выписки ДЕПО (PDF)' : 'отчёты брокера';
    const lines = [
        `Разобрала **${name}**: **${stats.filesProcessed}** файл(ов), **${stats.rowCount}** строк в одной таблице.`,
    ];
    if (stats.prefix) lines.push(`Префикс файлов: \`${stats.prefix}\`.`);
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
    MAX_BATCH_FILES,
    OPIF_SNAPSHOT_HEADERS,
    extractFilePrefix,
    detectBatchScenario,
    filterFilesForScenario,
    probeFileList,
    probeUploadedFile,
    parseOpifBatch,
    parseOpifFile,
    buildOpifAssistantMessage,
    isOpifScenario,
    fileNameOf,
    relativePathOf,
};
