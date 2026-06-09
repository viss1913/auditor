const { chatCompletion, extractJsonFromLlmContent } = require('./llm_client');
const { getTreeProfile, applyTreeProfileToRule } = require('./tree_profiles');
const { validateParsingRuleV2 } = require('./parsing_rule_v2_validate');
const { inferTreeLevels, CLUSTER_PATTERNS } = require('./infer_tree_levels');

const TREE_INTENT_RE =
    /дерев|иерарх|лист|уровн|договор|контрагент|подразделен|разверн|плоск|счёт|счет|групп|ртк|оп\s/i;

function isTreeIntentMessage(text) {
    return TREE_INTENT_RE.test(String(text || ''));
}

function buildTreePlannerPrompt({ message, treeInference, layoutMeta, baseRule }) {
    const clusters = treeInference?.clusterCounts || {};
    const clusterDesc = CLUSTER_PATTERNS.filter((c) => clusters[c.id] > 0)
        .map((c) => `${c.label}: ${clusters[c.id]} строк`)
        .join(', ');

    return `Ты — Martin, помощник аудитора. Пользователь описывает как развернуть ДЕРЕВО Excel в плоскую таблицу.

Факты из файла (не выдумывай):
- layout: ${layoutMeta?.recommended?.layout_type || 'unknown'}
- авто-детект: ${treeInference?.summary || '—'}
- кластеры в колонке дерева: ${clusterDesc || '—'}
- примеры path:
${JSON.stringify((treeInference?.examples || []).slice(0, 4), null, 2)}

Превью строк (колонка дерева):
${(layoutMeta?.preview_tsv || layoutMeta?.previewText || '').slice(0, 2000)}

Метаданные openpyxl (если есть — опирайся на них, не выдумывай):
- excel_probe: ${layoutMeta?.excel_probe?.ok ? 'да' : 'нет'}
- style_hints: ${JSON.stringify(layoutMeta?.style_hints || null)}
- has_row_outline: ${Boolean(layoutMeta?.has_row_outline)}
- skip_row_indices (подитоги): ${JSON.stringify(layoutMeta?.skip_row_indices || layoutMeta?.style_hints?.likely_subtotal_rows || [])}

Запрос аудитора:
${String(message || '')}

Верни ТОЛЬКО JSON:
{
  "profile_key": "os_76_card|os_08|os_01|null",
  "hierarchy": {
    "levels": [
      { "id": "account", "target": "Счёт, наименование счета", "patterns": ["^\\\\d{2}"] }
    ],
    "leaf": { "kind": "level_id", "level_id": "contract" }
  },
  "scenario_hint": "os_76_account_card|os_08_osv|os_01_hierarchy|os_01_flat|null",
  "explanation": "1-2 предложения по-русски"
}

Правила:
- patterns — JavaScript regex, экранируй обратным слэшем
- leaf.kind: level_id | os_08_object | leaf_rules
- Не задавай индексы колонок Excel
- Если неясно — profile_key null, объясни что нужно уточнить`;
}

function sanitizeLevels(rawLevels) {
    if (!Array.isArray(rawLevels)) return [];
    return rawLevels
        .map((l) => ({
            id: String(l?.id || '').trim(),
            target: String(l?.target || l?.id || '').trim(),
            patterns: Array.isArray(l?.patterns)
                ? l.patterns.map((p) => String(p).trim()).filter(Boolean)
                : [],
        }))
        .filter((l) => l.id && l.patterns.length);
}

function crossCheckProposal(proposal, treeInference) {
    const warnings = [];
    const counts = treeInference?.clusterCounts || {};
    const levelIds = (proposal.hierarchy?.levels || []).map((l) => l.id);

    if (proposal.profile_key === 'os_76_card' && !counts.contract && !counts.counterparty) {
        warnings.push('В файле не найдены Договор/Контрагент — проверьте лист');
    }
    if (levelIds.includes('contract') && !counts.contract) {
        warnings.push('Уровень contract в правиле, но в файле нет строк «Договор»');
    }
    if (levelIds.includes('counterparty') && !counts.counterparty) {
        warnings.push('Уровень counterparty в правиле, но в файле нет «Контрагент»');
    }

    return warnings;
}

function mergeProposalIntoRule(baseRule, proposal, layoutMeta) {
    let rule = baseRule ? JSON.parse(JSON.stringify(baseRule)) : {
        rule_schema_version: 2,
        meta: { name: 'Правило из диалога', source_type: 'excel' },
        layout: { layout_type: 'hierarchy_osv', name_column: 0 },
        columns: [],
        filters: { skip_row_patterns: ['^Итого'] },
    };

    if (proposal.profile_key && getTreeProfile(proposal.profile_key)) {
        rule = applyTreeProfileToRule(rule, proposal.profile_key);
    }

    if (proposal.hierarchy?.levels?.length) {
        rule.hierarchy = rule.hierarchy || {};
        rule.hierarchy.levels = sanitizeLevels(proposal.hierarchy.levels);
    }
    if (proposal.hierarchy?.leaf) {
        rule.hierarchy = rule.hierarchy || {};
        rule.hierarchy.leaf = proposal.hierarchy.leaf;
    }

    if (layoutMeta?.sheetName) {
        rule.meta = rule.meta || {};
        rule.meta.sheet_name = layoutMeta.sheetName;
    }

    return rule;
}

async function planTreeRuleWithLlm({ message, treeInference, layoutMeta, baseRule }) {
    if (!isTreeIntentMessage(message)) {
        return { ok: false, reason: 'not_tree_intent' };
    }

    try {
        const prompt = buildTreePlannerPrompt({ message, treeInference, layoutMeta, baseRule });
        const { content } = await chatCompletion({
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON-объектом.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.15,
        });
        const raw = extractJsonFromLlmContent(content);
        const proposal = {
            profile_key: raw.profile_key || raw.profileKey || null,
            hierarchy: {
                levels: sanitizeLevels(raw.hierarchy?.levels),
                leaf: raw.hierarchy?.leaf || null,
            },
            scenario_hint: raw.scenario_hint || raw.scenarioHint || null,
            explanation: String(raw.explanation || '').trim(),
        };

        let rule = mergeProposalIntoRule(baseRule, proposal, layoutMeta);
        const warnings = crossCheckProposal(proposal, treeInference);
        const validated = validateParsingRuleV2(rule);
        if (!validated.ok) {
            return { ok: false, errors: validated.errors, proposal, warnings };
        }

        return {
            ok: true,
            rule: validated.rule,
            proposal,
            warnings,
            explanation: proposal.explanation,
        };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

module.exports = {
    isTreeIntentMessage,
    planTreeRuleWithLlm,
    mergeProposalIntoRule,
    crossCheckProposal,
    sanitizeLevels,
};
