const { detectSuggestedScenario } = require('./scenarios/registry');
const { isSmartDialogEnabled } = require('./martin_flags');

function scenarioFromTreeProfile(profileKey) {
    return (
        {
            os_76_card: 'os_76_account_card',
            os_08: 'os_08_osv',
            os_01: 'os_01_hierarchy',
        }[profileKey] || null
    );
}

function shouldAutoFlattenTree(layoutMeta) {
    const treeInf = layoutMeta?.tree_inference;
    if (!treeInf?.examples?.length) return false;
    const layoutType =
        layoutMeta?.recommended?.layout_type || layoutMeta?.column_catalog?.layout_type;
    if (layoutMeta?.recommended?.profile_hint === 'uk_card') return false;
    return (
        layoutType === 'hierarchy_osv' ||
        treeInf.profileId === 'account_card' ||
        layoutType === 'hierarchy_rows'
    );
}

/**
 * Martin autostart: без вопросов — дерево сразу в плоскую, сценарий из детекта.
 */
function applyAutostartDefaults(layoutMeta, answers = {}) {
    const out = { ...answers };
    const treeInf = layoutMeta?.tree_inference;
    const smartDialog = isSmartDialogEnabled();

    if (!smartDialog) {
        if (!out.pick_tree_flatten && shouldAutoFlattenTree(layoutMeta)) {
            out.pick_tree_flatten = 'confirm';
        }
        if (out.pick_tree_flatten === 'confirm' && treeInf?.profileKey) {
            out.scenarioId = out.scenarioId || scenarioFromTreeProfile(treeInf.profileKey);
        }
    } else if (out.pick_tree_flatten === 'confirm' && treeInf?.profileKey) {
        out.scenarioId = out.scenarioId || scenarioFromTreeProfile(treeInf.profileKey);
    }

    if (!out.scenarioId) {
        const detected = detectSuggestedScenario(layoutMeta, null);
        if (detected.scenarioId && !(smartDialog && detected.needsUserChoice)) {
            out.scenarioId = detected.scenarioId;
        }
    }

    if (!out.sheetName && layoutMeta?.sheetName) {
        out.sheetName = layoutMeta.sheetName;
    }

    if (out.nameColumn == null) {
        const candidates =
            layoutMeta?.name_column_candidates ||
            layoutMeta?.column_catalog?.name_column_candidates ||
            [];
        if (candidates.length) out.nameColumn = candidates[0].index;
    }

    return out;
}

module.exports = {
    applyAutostartDefaults,
    shouldAutoFlattenTree,
    scenarioFromTreeProfile,
};
