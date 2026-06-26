/** Пресеты уровней дерева для разворота в плоскую таблицу. */

const OS_01_LEAF_RULES = {
    min_name_length: 20,
    inventory_patterns: [
        '\\d{2}\\.\\d{2}\\.\\d{4}',
        'инв\\.?',
        '№\\s*[\\dA-Z-]',
        '80-\\d+',
        '\\d{6,}',
    ],
    skip_name_patterns: ['^ОП\\s', '^РТК\\s', '^КЦ$', '^Итого'],
};

const PROFILES = {
    os_01: {
        id: 'os_01',
        scenarioId: 'os_01_hierarchy',
        layoutType: 'hierarchy_rows',
        levels: [
            {
                id: 'group',
                target: 'Группа',
                patterns: [
                    '^(Здания|Сооружения|Машины|Земельные|Транспорт|Офисное|Производственный|Другие виды)',
                ],
            },
            { id: 'unit', target: 'Узел', patterns: ['^РТК\\s', '^КЦ$'] },
            { id: 'branch', target: 'Подразделение', patterns: ['^ОП\\s'] },
        ],
        leaf: { kind: 'leaf_rules' },
        leaf_rules: OS_01_LEAF_RULES,
    },
    os_76_card: {
        id: 'os_76_card',
        scenarioId: 'os_76_account_card',
        layoutType: 'hierarchy_osv',
        emit_aggregate_rows: false,
        levels: [
            {
                id: 'account',
                target: 'Счёт, наименование счета',
                patterns: [
                    '^08(\\.|$)',
                    '^\\d{2}(\\.\\d+)*(,\\s|\\s|,|;|$)',
                    '^\\d{2}(\\.\\d+)+$',
                    '^76(\\.|,|\\s)',
                ],
            },
            { id: 'subdivision', target: 'Подразделение', patterns: ['^ОП\\s', '^Подразделение\\s'] },
            { id: 'counterparty', target: 'Контрагент', patterns: ['^Контрагент'] },
            { id: 'contract', target: 'Договор', patterns: ['^Договор\\s+\\d', '^Договор\\s+\\S'] },
        ],
        leaf: { kind: 'level_id', level_id: 'contract' },
    },
    os_08: {
        id: 'os_08',
        scenarioId: 'os_08_osv',
        layoutType: 'hierarchy_osv',
        emit_aggregate_rows: true,
        emit_aggregate_level_ids: ['account', 'subdivision'],
        levels: [
            {
                id: 'account',
                target: 'Счёт',
                patterns: [
                    '^08(\\.|$)',
                    '^\\d{2}(\\.\\d+)*(,\\s|\\s|,|;|$)',
                    '^\\d{2}(\\.\\d+)+$',
                    '^76(\\.|,|\\s)',
                ],
            },
            { id: 'subdivision', target: 'Подразделение', patterns: ['^ОП\\s', '^Подразделение\\s'] },
        ],
        leaf: { kind: 'os_08_object' },
    },
};

function getTreeProfile(profileId) {
    return PROFILES[profileId] ? JSON.parse(JSON.stringify(PROFILES[profileId])) : null;
}

function listTreeProfiles() {
    return Object.keys(PROFILES);
}

/** Записать levels/leaf из пресета в rule.hierarchy */
function applyTreeProfileToRule(rule, profileId) {
    const profile = getTreeProfile(profileId);
    if (!profile || !rule) return rule;
    rule.hierarchy = rule.hierarchy || {};
    rule.hierarchy.levels = profile.levels.map((l) => ({
        id: l.id,
        target: l.target,
        patterns: [...l.patterns],
    }));
    rule.hierarchy.leaf = { ...profile.leaf };
    if (profile.leaf_rules) {
        rule.hierarchy.leaf_rules = { ...profile.leaf_rules };
    }
    if (profile.emit_aggregate_rows) {
        rule.hierarchy.emit_aggregate_rows = true;
    }
    if (profile.emit_aggregate_level_ids?.length) {
        rule.hierarchy.emit_aggregate_level_ids = [...profile.emit_aggregate_level_ids];
    }
    if (profile.layoutType) {
        rule.layout = rule.layout || {};
        rule.layout.layout_type = profile.layoutType;
    }
    return rule;
}

function profileIdFromInference(inference) {
    if (!inference?.profileId) return null;
    const map = {
        account_card: 'os_76_card',
        os_08: 'os_08',
        os_01: 'os_01',
    };
    return map[inference.profileId] || inference.profileId;
}

module.exports = {
    PROFILES,
    getTreeProfile,
    listTreeProfiles,
    applyTreeProfileToRule,
    profileIdFromInference,
    OS_01_LEAF_RULES,
};
