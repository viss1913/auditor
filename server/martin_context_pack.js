const { scenarioDisplayName } = require('./scenarios/catalog');
const { formatTableMetaForAi } = require('./table_meta');

const HISTORY_LIMIT = 14;
const MESSAGE_CHAR_LIMIT = 400;
const SAMPLE_ROW_LIMIT = 2;

function truncateText(text, max = MESSAGE_CHAR_LIMIT) {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    return `${s.slice(0, max - 1)}…`;
}

function formatHistoryBlock(messages) {
    const items = (messages || [])
        .filter((m) => m?.content && (m.role === 'user' || m.role === 'assistant'))
        .slice(-HISTORY_LIMIT);
    if (!items.length) return '(пусто)';
    return items.map((m) => `${m.role}: ${truncateText(m.content)}`).join('\n');
}

function formatTablesBlock(snapshots, activeSnapshotId) {
    if (!snapshots?.length) return '(нет разобранных таблиц)';
    return snapshots
        .map((s) => {
            const active = Number(s.snapshotId) === Number(activeSnapshotId) ? ' [активная]' : '';
            const label = s.label || s.sheetName || s.sourceFileName || `таблица #${s.snapshotId}`;
            const scenario = s.scenarioId ? scenarioDisplayName(s.scenarioId) : '—';
            const file = s.sourceFileName ? ` · ${s.sourceFileName}` : '';
            const sheet = s.sheetName ? ` / ${s.sheetName}` : '';
            return `  • ${label}${active} — ${scenario}, ${s.rowCount ?? 0} строк${file}${sheet}`;
        })
        .join('\n');
}

function formatActiveTableBlock(active) {
    if (!active) return '(активная таблица не выбрана)';
    const parts = [];
    if (active.label) parts.push(`Вкладка: ${active.label}`);
    if (active.scenarioId) parts.push(`Сценарий: ${scenarioDisplayName(active.scenarioId)} (${active.scenarioId})`);
    if (active.sourceFileName) parts.push(`Файл: ${active.sourceFileName}`);
    if (active.sheetName) parts.push(`Лист: ${active.sheetName}`);
    parts.push(`Строк: ${active.rowCount ?? 0}`);
    if (active.headers?.length) {
        parts.push(`Колонки: ${active.headers.join(' | ')}`);
    }
    if (active.tableMeta?.tableLayout && active.tableMeta.tableLayout !== 'flat') {
        parts.push(formatTableMetaForAi(active.tableMeta));
    }
    if (active.sampleRows?.length) {
        for (let i = 0; i < active.sampleRows.length; i++) {
            parts.push(`Пример строки ${i + 1}: ${truncateText(JSON.stringify(active.sampleRows[i]), 500)}`);
        }
    }
    return parts.join('\n');
}

function buildUiContextFallback(uiContext = {}) {
    if (!uiContext?.headers?.length && !uiContext?.fileName) return '';
    const parts = ['Сводка с экрана (draft / без snapshot в БД):'];
    if (uiContext.fileName) parts.push(`Файл: ${uiContext.fileName}`);
    if (uiContext.sheetName) parts.push(`Лист: ${uiContext.sheetName}`);
    if (uiContext.scenarioName || uiContext.scenarioId) {
        parts.push(
            `Сценарий: ${uiContext.scenarioName || scenarioDisplayName(uiContext.scenarioId)} (${uiContext.scenarioId || '—'})`
        );
    }
    parts.push(`Строк: ${uiContext.rowCount ?? uiContext.rows?.length ?? 0}`);
    if (uiContext.headers?.length) parts.push(`Колонки: ${uiContext.headers.join(' | ')}`);
    if (uiContext.tableMeta?.tableLayout && uiContext.tableMeta.tableLayout !== 'flat') {
        parts.push(formatTableMetaForAi(uiContext.tableMeta));
    }
    const sample = uiContext.sampleRow || uiContext.rows?.[0];
    if (sample) parts.push(`Пример: ${truncateText(JSON.stringify(sample), 500)}`);
    if (uiContext.layoutSummary) parts.push(uiContext.layoutSummary);
    return parts.join('\n');
}

function mergeContextPacks(projectPack, uiPack) {
    const blocks = [projectPack, uiPack].filter((s) => String(s || '').trim());
    return blocks.join('\n\n');
}

/**
 * @param {{ chatStore: object, snapshotStore: object, chatSessionId?: number, projectId?: number, activeSnapshotId?: number }} opts
 */
async function buildProjectContextPack({ chatStore, snapshotStore, chatSessionId, projectId, activeSnapshotId }) {
    const parts = [];

    if (chatSessionId) {
        const chat = await chatStore.getChatSession(chatSessionId);
        if (chat) {
            parts.push(`Чат #${chat.id}${chat.title ? ` «${chat.title}»` : ''}`);
            if (chat.projectId != null) parts.push(`Проект #${chat.projectId}`);
        }

        const snapshots = await chatStore.listChatSnapshots(chatSessionId);
        const messages = await chatStore.getChatMessages(chatSessionId, HISTORY_LIMIT + 4);

        parts.push(`\nТаблицы в сессии (${snapshots.length}):`);
        parts.push(formatTablesBlock(snapshots, activeSnapshotId));

        let activeMeta = null;
        if (activeSnapshotId) {
            activeMeta = snapshots.find((s) => Number(s.snapshotId) === Number(activeSnapshotId)) || null;
            const snap = await snapshotStore.getSnapshot(activeSnapshotId);
            if (snap) {
                const page = await snapshotStore.fetchRowsPage(activeSnapshotId, { page: 1, limit: SAMPLE_ROW_LIMIT });
                activeMeta = {
                    ...activeMeta,
                    label: activeMeta?.label || snap.sheetName || snap.sourceFileName,
                    scenarioId: snap.scenarioId,
                    sourceFileName: snap.sourceFileName,
                    sheetName: snap.sheetName,
                    rowCount: snap.rowCount,
                    headers: snap.headers || [],
                    tableMeta: snap.tableMeta || null,
                    sampleRows: (page.rows || []).slice(0, SAMPLE_ROW_LIMIT),
                };
            }
        }

        parts.push('\nАктивная таблица:');
        parts.push(formatActiveTableBlock(activeMeta));

        parts.push('\nНедавний диалог:');
        parts.push(formatHistoryBlock(messages));
    } else if (projectId) {
        parts.push(`Проект #${projectId} (чат не привязан)`);
    } else {
        parts.push('(нет привязки к чату/проекту)');
    }

    return parts.join('\n');
}

module.exports = {
    HISTORY_LIMIT,
    MESSAGE_CHAR_LIMIT,
    SAMPLE_ROW_LIMIT,
    truncateText,
    formatHistoryBlock,
    formatTablesBlock,
    formatActiveTableBlock,
    buildUiContextFallback,
    mergeContextPacks,
    buildProjectContextPack,
};
