const { chatCompletion } = require('./llm_client');
const {
    applyScenario,
    buildScenarioChoiceMessage,
    detectSuggestedScenario,
    resolveScenarioFromMessage,
    getTreeSample,
    listScenarios,
} = require('./scenarios/registry');
const { scenarioDisplayName } = require('./scenarios/catalog');

function formatCompareSummary(compare) {
    if (!compare) return null;
    const s = compare.summary || {};
    const lines = [
        `Совпало строк: ${s.matched || 0}`,
        `Нет в эталоне: ${s.missingInTarget || 0}`,
        `Нет в превью: ${s.missingInPreview || 0}`,
        `Расхождений: ${s.mismatchCount || 0}`,
    ];
    if (s.keyColumns?.length) lines.push(`Ключ сравнения: ${s.keyColumns.join(', ')}`);
    const samples = (compare.mismatches || []).slice(0, 3).map((m) => {
        if (m.type === 'value_mismatch' && m.diffs?.length) {
            return `«${m.key}»: ${m.diffs.map((d) => `${d.column} превью=${d.preview} эталон=${d.target}`).join('; ')}`;
        }
        return `${m.type}: ${m.key || ''}`;
    });
    return { text: lines.join('\n'), ok: compare.ok, samples };
}

function formatTreeExamples(layoutMeta, limit = 2) {
    return getTreeSample(layoutMeta)
        .slice(0, limit)
        .map((r) => `${(r.path || []).join(' → ')} → ${(r.leaf_name || '').slice(0, 50)}`)
        .join('\n');
}

function buildTemplateMessage({
    preview,
    compare,
    rule,
    layoutMeta,
    isFirstPass,
    ruleDiff,
    targetUsed,
    scenarioId,
    needsScenarioChoice,
}) {
    const parts = [];
    const layout = layoutMeta?.recommended?.layout_type || rule?.layout?.layout_type || 'hierarchy_rows';
    const profileHint = layoutMeta?.recommended?.profile_hint;

    if (needsScenarioChoice) {
        return buildScenarioChoiceMessage(layoutMeta);
    }

    if (isFirstPass) {
        if (scenarioId === 'uk_card' || profileHint === 'uk_card') {
            const probe = layoutMeta?.uk_probe;
            const qtyLetter =
                probe?.quantity_options?.find((o) => o.index === probe.quantity_column)?.letter ||
                (probe?.quantity_column === 7 ? 'H' : probe?.quantity_column === 8 ? 'I' : '');
            const probeLine = probe
                ? `Кол. в колонке **${qtyLetter || probe.quantity_column}**${probe.has_credit_91 ? ', есть переоценки (91)' : ''}.`
                : '';
            parts.push(
                `Привет! Это **карточка УК 58.01** — парсим все проводки с Дт 58.01 (включая 91). ${probeLine}`.trim()
            );
        } else if (scenarioId === 'card_90_tsv' || scenarioId === 'deals_registry_tsv') {
            parts.push(`Привет! Разобрала **текстовую выгрузку 1С** — ${scenarioDisplayName(scenarioId)}.`);
        } else if (scenarioId === 'wide_metrics' || profileHint === 'os_wide_years') {
            parts.push('Привет! Это **ведомость ОС с годами в шапке колонок** (wide).');
        } else if (scenarioId === 'os_76_account_card' || profileHint === 'os_account_card_76') {
            parts.push('Привет! Это **карточка счёта 76** — счёт → подразделение → контрагент → договор.');
        } else if (scenarioId === 'os_08_osv' || profileHint === 'os_osv_08') {
            parts.push('Привет! Это **ОСВ по счёту 08** — иерархия объектов и обороты.');
        } else {
            parts.push(`Привет! Разобрала файл — layout **${layout}**.`);
            const treeEx = formatTreeExamples(layoutMeta);
            if (treeEx) parts.push(`Дерево в колонке A, пример:\n${treeEx}`);
        }
    } else {
        parts.push('Обновила таблицу по твоему запросу.');
    }

    if (scenarioId) {
        const sc = listScenarios().find((s) => s.id === scenarioId);
        const label = sc?.name || scenarioDisplayName(scenarioId);
        if (label) parts.push(`Сценарий: **${label}** (\`${scenarioId}\`).`);
    }

    if (targetUsed) {
        parts.push('Колонки взяла из **эталона** — как в твоём примере.');
    }

    parts.push(`Получилось **${preview?.rowCount ?? 0}** строк.`);

    const cols = preview?.headers || rule?.columns?.map((c) => c.target) || [];
    if (cols.length) {
        parts.push(`Колонки: ${cols.slice(0, 8).join(', ')}${cols.length > 8 ? '…' : ''}.`);
    }

    if (ruleDiff?.changes?.length) {
        parts.push(`Изменила: ${ruleDiff.changes.join('; ')}.`);
    }

    const cmp = formatCompareSummary(compare);
    if (cmp) {
        if (cmp.ok) {
            parts.push('✓ **С эталоном совпало.** Можно сохранять правило.');
        } else {
            parts.push('⚠ **С эталоном есть расхождения.**');
            if (cmp.samples.length) parts.push(cmp.samples.join('\n'));
        }
    } else if (isFirstPass && !needsScenarioChoice) {
        parts.push('**Так норм?** Или напиши что изменить.');
    }

    return parts.join('\n\n');
}

function getMartinConversationalPrompt() {
    return `Ты — Martin, AI-помощник аудитора BankFuture. Общаешься по-русски, коротко и по делу.

Твоя роль:
- Объяснить результат разбора Excel (строки, колонки).
- Если detect показал дерево — объясни уровни (ОС 01: Группа→РТК→ОП→ОС; карточка 76: Счёт→Подразделение→Контрагент→Договор) и спроси подтверждение разворота в плоскую таблицу.
- Если есть сравнение с эталоном — скажи, совпало или где расхождения (без выдумывания цифр).

ЗАПРЕЩЕНО: JSON, код, длинные простыни, выдуманные числа.
Формат: 3–6 предложений, можно markdown (**жирный**).`;
}

function buildCellClassificationPrompt(cellText, auditorRule = '') {
    const ruleBlock = auditorRule
        ? `\nПравило и контекст от аудитора (обязательно учти):\n${String(auditorRule).trim()}\n`
        : '';
    return `Ты классифицируешь описание актива из одной ячейки таблицы.
Допустимые классы: movable, real_estate, rent, repair, other, not_sure.
Верни строго JSON-объект формата:
{"class":"movable|real_estate|rent|repair|other|not_sure","confidence":0.0,"reason":"кратко"}
Без markdown и без пояснений вне JSON.
${ruleBlock}
Текст ячейки:
${String(cellText || '')}`;
}

function isValidCellClassificationJson(value) {
    if (!value || typeof value !== 'object') return false;
    const allowed = new Set(['movable', 'real_estate', 'rent', 'repair', 'other', 'not_sure']);
    if (!allowed.has(String(value.class || '').trim())) return false;
    const confidence = Number(value.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return false;
    if (typeof value.reason !== 'string') return false;
    return true;
}

async function generateMartinReply({ messages, context, fallbackMessage }) {
    try {
        const llmMessages = [
            { role: 'system', content: getMartinConversationalPrompt() },
            {
                role: 'user',
                content: `Контекст текущего разбора:\n${context}\n\nОтветь аудитору по последнему сообщению в диалоге.`,
            },
        ];
        const lastFew = (messages || []).filter((m) => m.role !== 'system').slice(-6);
        for (const m of lastFew) {
            llmMessages.push({ role: m.role, content: String(m.content || '') });
        }
        const { content } = await chatCompletion({ messages: llmMessages, temperature: 0.4 });
        return content.trim();
    } catch (e) {
        return fallbackMessage + (e.message ? `\n\n_(ИИ временно недоступен: ${e.message})_` : '');
    }
}

function buildLlmContext({
    preview,
    compare,
    rule,
    layoutMeta,
    ruleDiff,
    userMessage,
    scenarioId,
    needsScenarioChoice,
    awaitingTreeConfirm,
}) {
    const parts = [];
    if (layoutMeta?.recommended) {
        parts.push(`Layout: ${layoutMeta.recommended.layout_type} — ${layoutMeta.recommended.description}`);
    }
    if (layoutMeta?.tree_inference?.summary) {
        parts.push(`tree_inference: ${layoutMeta.tree_inference.summary}`);
    }
    if (layoutMeta?.excel_probe?.ok) {
        parts.push('excel_probe: openpyxl (бары, цвета, мержи)');
    }
    if (layoutMeta?.style_hints) {
        const sh = layoutMeta.style_hints;
        const hints = [];
        if (sh.likely_subtotal_rows?.length) {
            hints.push(`подитоги (строки): ${sh.likely_subtotal_rows.slice(0, 12).join(', ')}`);
        }
        if (sh.gray_fill_rows?.length) {
            hints.push(`серый фон (подитоги): ${sh.gray_fill_rows.slice(0, 8).join(', ')}`);
        }
        if (sh.hierarchy_fill_rows?.length) {
            hints.push(`зелёная иерархия 1С: ${sh.hierarchy_fill_rows.slice(0, 8).join(', ')}`);
        }
        if (sh.hidden_rows?.length) {
            hints.push(`скрытые строки: ${sh.hidden_rows.length}`);
        }
        if (layoutMeta.has_row_outline) {
            hints.push('есть группировка Excel (бары слева)');
        }
        if (hints.length) parts.push(`style_hints: ${hints.join('; ')}`);
    }
    if (scenarioId) parts.push(`Сценарий: ${scenarioId}`);
    if (needsScenarioChoice) parts.push('Требуется выбор: os_01_flat или os_01_hierarchy');
    if (awaitingTreeConfirm) parts.push('Ждём подтверждения разворота дерева (pick_tree_flatten). Полный парс в БД — только после «Да».');
    const treeSample = getTreeSample(layoutMeta);
    if (treeSample.length) {
        parts.push(`hierarchy_tree_sample:\n${JSON.stringify(treeSample.slice(0, 6))}`);
    }
    parts.push(`Строк в превью: ${preview?.rowCount ?? 0}`);
    parts.push(`Колонки: ${(preview?.headers || []).join(' | ')}`);
    if (preview?.rows?.length) {
        parts.push(`Пример строки: ${JSON.stringify(preview.rows[0])}`);
    }
    const cmp = formatCompareSummary(compare);
    if (cmp) parts.push(`Сравнение с эталоном:\n${cmp.text}${cmp.samples.length ? '\n' + cmp.samples.join('\n') : ''}`);
    if (ruleDiff?.changes?.length) parts.push(`Изменения правила: ${ruleDiff.changes.join('; ')}`);
    if (userMessage) parts.push(`Последний запрос: «${userMessage}»`);
    return parts.join('\n\n');
}

/** @deprecated use applyScenario from scenarios/registry */
function buildDefaultRule(layoutMeta, target) {
    const detected = detectSuggestedScenario(layoutMeta, target);
    const id = detected.scenarioId || 'os_01_flat';
    return applyScenario(id, layoutMeta, target);
}

module.exports = {
    buildDefaultRule,
    buildTemplateMessage,
    generateMartinReply,
    buildLlmContext,
    formatCompareSummary,
    formatTreeExamples,
    buildCellClassificationPrompt,
    isValidCellClassificationJson,
};
