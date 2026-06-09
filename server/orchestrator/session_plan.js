const {
    detectSuggestedScenario,
    hasDeepTree,
    getTreeSample,
    isAccountCard76,
    inferScenarioFromRule,
} = require('../scenarios/registry');
const { resolveStructureFromMessage } = require('./structure_resolve');
const { detectUkQuantityColumn } = require('./uk_detect');
const { applyAutostartDefaults } = require('../autostart_defaults');
const { pickPreferredSheet } = require('../excel_sheet_meta');

const SCORE_AMBIGUITY_GAP = 3;

function detectProfile(layoutMeta) {
    const layoutType =
        layoutMeta?.recommended?.layout_type || layoutMeta?.column_catalog?.layout_type;
    if (isAccountCard76(layoutMeta)) return 'os_76';
    if (layoutType === 'hierarchy_osv') return 'os_08';
    if (layoutType === 'fixed_columns') return 'uk_card';
    if (layoutType === 'wide_metrics') return 'os_01';
    if (layoutType === 'hierarchy_rows') return 'os_01';
    const sheet = String(layoutMeta?.sheetName || '').toLowerCase();
    if (/08|осв/i.test(sheet)) return 'os_08';
    if (/01|амортизац/i.test(sheet)) return 'os_01';
    return 'unknown';
}

function sourceSheetCandidates(layoutMeta) {
    const names = layoutMeta?.sheetNames || [];
    const matched = names.filter((s) => /исходн|01|08|амортизац|осв/i.test(s));
    return matched.length >= 2 ? matched : [];
}

function needsNameColumnQuestion(layoutMeta, state) {
    if (state.nameColumn != null) return false;
    const layoutType =
        layoutMeta?.recommended?.layout_type || layoutMeta?.column_catalog?.layout_type;
    if (layoutType !== 'hierarchy_rows' && state.profileId !== 'os_01') return false;

    const candidates =
        layoutMeta?.name_column_candidates ||
        layoutMeta?.column_catalog?.name_column_candidates ||
        [];
    if (candidates.length < 2) return false;
    const top = candidates[0]?.score ?? 0;
    const second = candidates[1]?.score ?? 0;
    return top - second < SCORE_AMBIGUITY_GAP && top > 0;
}

function buildQuestion(id, promptTemplate, options, extra = {}) {
    return { id, promptTemplate, options, ...extra };
}

function createSessionState(layoutMeta, overrides = {}) {
    return {
        step: 'profile',
        profileId: null,
        sheetName: layoutMeta?.sheetName || null,
        nameColumn: null,
        scenarioId: null,
        amountColumn: null,
        quantityColumn: null,
        ukMode: null,
        compositeColumn: null,
        compositeExtracts: [],
        answers: {},
        ...overrides,
    };
}

/**
 * @param {Object} layoutMeta
 * @param {Object|null} target
 * @param {Object|null} currentRule
 * @param {{ scenarioIdParam?: string, userMessage?: string, answers?: Object, savedRules?: Array }} opts
 */
function buildSessionPlan(layoutMeta, target, currentRule, opts = {}) {
    const { scenarioIdParam, userMessage, answers = {}, savedRules = [], autostart = true } = opts;
    const effectiveAnswers = autostart ? applyAutostartDefaults(layoutMeta, answers) : { ...answers };
    const detected = detectSuggestedScenario(layoutMeta, target);
    const structFromMsg = resolveStructureFromMessage(userMessage, layoutMeta);

    const autoResolved = {};
    let state = createSessionState(layoutMeta, {
        profileId: detectProfile(layoutMeta),
        scenarioId:
            scenarioIdParam ||
            structFromMsg.scenarioId ||
            (currentRule ? inferScenarioFromRule(currentRule) : detected.scenarioId),
        sheetName: structFromMsg.sheetName || layoutMeta?.sheetName,
        nameColumn:
            structFromMsg.nameColumn ??
            layoutMeta?.column_catalog?.name_column?.index ??
            null,
        quantityColumn: structFromMsg.quantityColumn ?? null,
        ukMode: structFromMsg.ukMode ?? effectiveAnswers.ukMode ?? null,
        amountColumn: structFromMsg.amountColumn ?? null,
        answers: { ...effectiveAnswers },
    });

    if (effectiveAnswers.scenarioId && !scenarioIdParam) {
        state.scenarioId = effectiveAnswers.scenarioId;
    }
    if (effectiveAnswers.sheetName) state.sheetName = effectiveAnswers.sheetName;
    if (effectiveAnswers.nameColumn != null) state.nameColumn = Number(effectiveAnswers.nameColumn);

    if (target?.headers?.length) {
        state.scenarioId = 'from_target';
        autoResolved.scenarioId = 'from_target';
    }

    if (effectiveAnswers.scenarioId) state.scenarioId = effectiveAnswers.scenarioId;
    if (effectiveAnswers.sheetName) state.sheetName = effectiveAnswers.sheetName;
    if (effectiveAnswers.nameColumn != null) state.nameColumn = Number(effectiveAnswers.nameColumn);
    if (effectiveAnswers.profileId) state.profileId = effectiveAnswers.profileId;
    if (structFromMsg.profileId) state.profileId = structFromMsg.profileId;
    if (effectiveAnswers.quantityColumn != null) state.quantityColumn = Number(effectiveAnswers.quantityColumn);
    if (effectiveAnswers.ukMode) state.ukMode = effectiveAnswers.ukMode;
    if (effectiveAnswers.amountColumn != null) state.amountColumn = Number(effectiveAnswers.amountColumn);
    if (effectiveAnswers.compositeColumn != null) state.compositeColumn = Number(effectiveAnswers.compositeColumn);
    if (Array.isArray(effectiveAnswers.compositeExtracts)) {
        state.compositeExtracts = effectiveAnswers.compositeExtracts;
    }

    const treeInfEarly = layoutMeta?.tree_inference;
    if (effectiveAnswers.pick_tree_flatten === 'confirm' && treeInfEarly?.profileKey) {
        const scenarioFromTree = {
            os_76_card: 'os_76_account_card',
            os_08: 'os_08_osv',
            os_01: 'os_01_hierarchy',
        };
        state.scenarioId = scenarioFromTree[treeInfEarly.profileKey] || state.scenarioId;
    }

    const pendingQuestions = [];

    const matchedRule = matchSavedRule(layoutMeta, savedRules);
    const treeConfirmLocksScenario =
        effectiveAnswers.pick_tree_flatten === 'confirm' && Boolean(treeInfEarly?.profileKey);
    if (matchedRule && !currentRule && !scenarioIdParam && !treeConfirmLocksScenario) {
        autoResolved.savedRuleId = matchedRule.id;
        autoResolved.savedRule = matchedRule.rule_json;
        state.scenarioId = inferScenarioFromRule(matchedRule.rule_json);
        state.nameColumn = matchedRule.rule_json?.layout?.name_column ?? state.nameColumn;
        state.sheetName = matchedRule.rule_json?.meta?.sheet_name || state.sheetName;
    }

    const sheets = sourceSheetCandidates(layoutMeta);
    if (!state.sheetName && sheets.length >= 2 && !effectiveAnswers.sheetName) {
        state.sheetName = pickPreferredSheet(sheets) || sheets[0];
        autoResolved.sheetName = state.sheetName;
    }

    if (needsNameColumnQuestion(layoutMeta, state) && effectiveAnswers.nameColumn === undefined) {
        const candidates =
            layoutMeta?.name_column_candidates ||
            layoutMeta?.column_catalog?.name_column_candidates ||
            [];
        if (candidates.length) {
            state.nameColumn = candidates[0].index;
            autoResolved.nameColumn = state.nameColumn;
        }
    }

    if (
        detected.needsUserChoice &&
        !state.scenarioId &&
        !currentRule &&
        !target?.headers?.length &&
        !effectiveAnswers.scenarioId
    ) {
        state.scenarioId = detected.scenarioId || 'os_01_hierarchy';
        autoResolved.scenarioId = state.scenarioId;
    }

    if (state.profileId === 'uk_card') {
        const probe = layoutMeta?.uk_probe;
        const uk = layoutMeta?.uk_quantity_detect;
        const qtyOpts = probe?.quantity_options?.length
            ? probe.quantity_options
            : uk?.options || [];
        const qtyAmbiguous =
            (probe?.quantity_ambiguous || uk?.ambiguous) && !effectiveAnswers.quantityColumn;
        if (state.quantityColumn == null && qtyAmbiguous && qtyOpts.length) {
            pendingQuestions.push(
                buildQuestion(
                    'pick_uk_quantity_column',
                    'На строках «Кол.» количество может быть в другой колонке, чем сальдо. Где штуки?',
                    qtyOpts.map((o) => ({
                        value: String(o.index),
                        label: `Колонка ${o.letter}${o.sample ? ` — пример: ${o.sample}` : ''}${o.median != null ? ` (медиана ${o.median})` : ''}`,
                    }))
                )
            );
        } else {
            const suggested =
                probe?.quantity_column ?? uk?.suggested ?? state.quantityColumn;
            if (suggested != null && state.quantityColumn == null) {
                state.quantityColumn = suggested;
                autoResolved.quantityColumn = suggested;
            }
        }
    }

    // --- Composite-cell extraction (например: "Блок…, 000002272, 01.10.2018") ---
    const wantInventory =
        typeof userMessage === 'string' &&
        /инвентар|инв\.?|инв\.?\s*№|инвент/i.test(userMessage);
    const wantDate =
        typeof userMessage === 'string' &&
        (/дата|принят/i.test(userMessage) || /\d{2}\.\d{2}\.\d{4}/.test(userMessage));

    const desiredExtracts = [];
    if (wantInventory) desiredExtracts.push('inventory_number');
    if (wantDate) desiredExtracts.push('date_ddmmyyyy');

    const haveExtracts = Array.isArray(state.compositeExtracts) ? state.compositeExtracts : [];
    const remainingExtracts = desiredExtracts.filter((d) => !haveExtracts.includes(d));

    if (
        pendingQuestions.length === 0 &&
        desiredExtracts.length > 0 &&
        state.compositeColumn == null
    ) {
        const candidates =
            layoutMeta?.name_column_candidates ||
            layoutMeta?.column_catalog?.name_column_candidates ||
            [];
        const options = (candidates.length ? candidates : [{ index: 2, letter: 'C', score: 1, sample: '' }]).slice(
            0,
            3
        );
        pendingQuestions.push(
            buildQuestion(
                'pick_composite_column',
                'В составной ячейке нужно вытащить инвентарный номер и/или дату. Из какой колонки брать строку?',
                options.map((c) => ({
                    value: String(c.index),
                    label: `Колонка ${c.letter} — пример: ${(c.sample || '').slice(0, 50)}`,
                }))
            )
        );
    } else if (pendingQuestions.length === 0 && remainingExtracts.length > 0) {
        pendingQuestions.push(
            buildQuestion(
                'pick_composite_field',
                'Что именно выделять из этой составной ячейки?',
                remainingExtracts.map((f) =>
                    f === 'inventory_number'
                        ? { value: f, label: 'Инвентарный номер' }
                        : f === 'date_ddmmyyyy'
                          ? { value: f, label: 'Дата (01.10.2018)' }
                          : { value: f, label: f }
                )
            )
        );
    }

    if (pendingQuestions.length === 0) {
        state.step = 'ready';
    } else {
        state.step = pendingQuestions[0].id;
    }

    return {
        sessionState: state,
        pendingQuestions,
        currentQuestion: pendingQuestions[0] || null,
        autoResolved,
        detected,
        profileId: state.profileId,
        scenarioId: state.scenarioId,
        needsUserInput: pendingQuestions.length > 0,
        layoutMeta,
        target,
        currentRule,
        savedRules,
    };
}

function applyAnswer(plan, questionId, value) {
    const state = { ...plan.sessionState, answers: { ...plan.sessionState.answers } };
    state.answers[questionId] = value;

    if (questionId === 'pick_sheet') state.answers.sheetName = value;
    if (questionId === 'pick_profile') state.answers.profileId = value;
    if (questionId === 'pick_name_column') state.answers.nameColumn = Number(value);
    if (questionId === 'pick_scenario') state.answers.scenarioId = value;
    if (questionId === 'pick_tree_flatten') {
        state.answers.pick_tree_flatten = value;
        if (String(value).startsWith('scenario:')) {
            state.answers.scenarioId = String(value).slice('scenario:'.length);
        }
    }
    if (questionId === 'pick_uk_quantity_column') {
        state.answers.quantityColumn = Number(value);
        state.quantityColumn = Number(value);
    }
    if (questionId === 'pick_uk_mode') {
        state.answers.ukMode = value;
        state.ukMode = value;
    }
    if (questionId === 'pick_composite_column') state.answers.compositeColumn = Number(value);
    if (questionId === 'pick_composite_field') {
        state.answers.compositeExtracts = [
            ...(state.answers.compositeExtracts || []),
            value,
        ];
    }

    return buildSessionPlan(plan.layoutMeta, plan.target, plan.currentRule, {
        scenarioIdParam: state.scenarioId || state.answers.scenarioId,
        answers: state.answers,
        savedRules: plan.savedRules,
    });
}

function isReadyToParse(plan, currentRule) {
    if (plan.needsUserInput) return false;
    if (currentRule) return true;
    if (plan.autoResolved?.savedRule) return true;
    if (plan.scenarioId) return true;
    if (plan.sessionState?.profileId === 'uk_card') return true;
    return false;
}

function layoutFingerprint(layoutMeta) {
    const sheet = layoutMeta?.sheetName || '';
    const layout =
        layoutMeta?.recommended?.layout_type || layoutMeta?.column_catalog?.layout_type || '';
    const hint = layoutMeta?.recommended?.profile_hint || '';
    const metrics = (layoutMeta?.column_catalog?.metrics || [])
        .slice(0, 5)
        .map((m) => m.suggested_measure)
        .join(',');
    return `${sheet}|${layout}|${hint}|${metrics}`;
}

function matchSavedRule(layoutMeta, savedRules) {
    if (!savedRules?.length) return null;
    const fp = layoutFingerprint(layoutMeta);
    const fileName = String(layoutMeta?.sourceFileName || '').toLowerCase();
    const recommendedHint = layoutMeta?.recommended?.profile_hint || '';

    for (const row of savedRules) {
        let rule = row.rule_json;
        if (typeof rule === 'string') {
            try {
                rule = JSON.parse(rule);
            } catch {
                continue;
            }
        }
        const hint = rule?.meta?.profile_hint || '';
        const ukMode = rule?.meta?.uk_mode || rule?.conditions?.mode || '';
        const layout = rule?.layout?.layout_type || '';
        const sheet = rule?.meta?.sheet_name || '';
        const rowFp = `${sheet}|${layout}|${hint}|${ukMode}|`;

        if (hint && recommendedHint && hint === recommendedHint) {
            return { ...row, rule_json: rule };
        }
        if (fp.startsWith(rowFp) || (hint && fp.includes(hint))) {
            return { ...row, rule_json: rule };
        }
        if (row.fixture_file_name && fileName) {
            if (String(row.fixture_file_name).toLowerCase() === fileName) {
                return { ...row, rule_json: rule };
            }
        }
        if (hint === 'uk_card' && /карт|58[.,]\s*0?1/i.test(fileName)) {
            return { ...row, rule_json: rule };
        }
    }
    return null;
}

function applyOrchestratorToLayoutMeta(layoutMeta, sessionState) {
    if (!layoutMeta || !sessionState) return layoutMeta;
    const meta = { ...layoutMeta };
    if (sessionState.sheetName) meta.sheetName = sessionState.sheetName;
    if (sessionState.nameColumn != null) {
        meta.column_catalog = {
            ...(meta.column_catalog || {}),
            name_column: { index: sessionState.nameColumn },
        };
    }
    if (sessionState.profileId === 'uk_card' && sessionState.quantityColumn != null) {
        meta.uk_quantity_column = sessionState.quantityColumn;
    }
    if (sessionState.profileId === 'uk_card' && sessionState.ukMode) {
        meta.uk_mode = sessionState.ukMode;
    }
    return meta;
}

module.exports = {
    buildSessionPlan,
    applyAnswer,
    isReadyToParse,
    createSessionState,
    detectProfile,
    layoutFingerprint,
    matchSavedRule,
    applyOrchestratorToLayoutMeta,
    hasDeepTree,
};
