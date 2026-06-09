/**
 * Серверный реестр: какой профиль → какие движки и эндпоинты.
 * Используется для GET /api/parser-profiles и будущего единого dispatch.
 */
const PARSER_PROFILES = [
    {
        id: 'anton',
        name: 'Антон',
        title: 'Парсинг 1С (ОС)',
        status: 'ready',
        engines: ['parse_engine', 'scenarios/registry', 'parse_snapshot_import', 'cell_enrich'],
        endpoints: {
            start: 'POST /api/parse/auto-start',
            rows: 'GET /api/parse/snapshots/:id/rows',
            operate: 'POST /api/parse/snapshots/:id/apply-operation',
            chat: 'POST /api/ai/chat',
        },
        cursorAgent: 'anton',
    },
    {
        id: 'lyubov',
        name: 'Любовь',
        title: 'Аудит ОПИФ: УК · Брокер · ДЕПО',
        status: 'ready',
        engines: ['parse_uk', 'parseBroker', 'parseDEPO'],
        endpoints: {
            upload: 'POST /upload',
            list: 'GET /trades?source={uk|broker|depo}',
            audit: 'GET /audit',
            auditPreview: 'GET /audit/preview',
        },
        cursorAgent: 'lyubov',
    },
    {
        id: 'pavel',
        name: 'Павел',
        title: 'Нетиповые Excel / договоры',
        status: 'planned',
        engines: [],
        endpoints: {
            generateRule: 'POST /api/ai/generate-rule-from-file',
        },
        cursorAgent: 'pavel',
    },
    {
        id: 'kseniya',
        name: 'Ксения',
        title: 'Эталон и сверка колонок',
        status: 'ready',
        engines: ['parse_1c_tsv', 'target_rule_infer', 'compare_target'],
        endpoints: {
            parseText: 'POST /api/kseniya/parse-text',
            inferFromTarget: 'POST /api/parse/infer-from-target',
            compareTarget: 'POST /api/parse/compare-target',
        },
        cursorAgent: 'kseniya',
    },
];

function listParserProfiles() {
    return PARSER_PROFILES;
}

function getParserProfile(id) {
    return PARSER_PROFILES.find((p) => p.id === id) || null;
}

/**
 * Заготовка dispatch: по profileId вернуть метаданные для оркестратора.
 */
function resolveParserDispatch(profileId) {
    const profile = getParserProfile(profileId);
    if (!profile) return { ok: false, error: `Неизвестный профиль: ${profileId}` };
    return { ok: true, profile };
}

module.exports = { listParserProfiles, getParserProfile, resolveParserDispatch };
