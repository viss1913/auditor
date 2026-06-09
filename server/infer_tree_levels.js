const { getTreeProfile, applyTreeProfileToRule } = require('./tree_profiles');
const { walkTree, cellText } = require('./tree_walker');
const { hasDeepTree } = require('./scenarios/registry');
const { isUkDateLabel } = require('./uk_card_detect');

const CLUSTER_PATTERNS = [
    {
        id: 'account',
        re: /^(\d{2}(\.\d+)+[,\s]|08(\.|$)|76(\.|,|\s)|^\d{2}(\.\d+)*(,\s|\s|,))/i,
        label: 'Счёт',
    },
    { id: 'subdivision', re: /^Подразделение\s|^ОП\s/i, label: 'Подразделение' },
    { id: 'counterparty', re: /^Контрагент/i, label: 'Контрагент' },
    { id: 'contract', re: /^Договор\s+\S/i, label: 'Договор' },
    { id: 'group', re: /^(Здания|Сооружения|Машины|Земельные|Транспорт|Офисное)/i, label: 'Группа' },
    { id: 'unit', re: /^РТК\s|^КЦ$/i, label: 'Узел' },
    { id: 'branch', re: /^ОП\s/i, label: 'ОП' },
];

function countClusters(data, nameCol = 0) {
    const counts = {};
    for (const row of data) {
        const label = cellText(row, nameCol);
        if (!label || isUkDateLabel(label)) continue;
        for (const c of CLUSTER_PATTERNS) {
            if (c.re.test(label)) {
                counts[c.id] = (counts[c.id] || 0) + 1;
            }
        }
    }
    return counts;
}

function detectProfileId(counts, layoutMeta) {
    if (layoutMeta?.recommended?.profile_hint === 'uk_card') {
        return 'generic';
    }
    if ((counts.contract || 0) > 0 && (counts.counterparty || 0) > 0) {
        return 'account_card';
    }
    const sheetLower = String(layoutMeta?.sheetName || '').toLowerCase();
    const has08Sheet = /08|осв/i.test(sheetLower);
    if ((counts.account || 0) > 0 && has08Sheet) {
        return 'os_08';
    }
    if (hasDeepTree(layoutMeta)) {
        return 'os_01';
    }
    const layoutType = layoutMeta?.recommended?.layout_type;
    if (layoutType === 'hierarchy_osv') return 'account_card';
    if (layoutType === 'hierarchy_rows') return 'os_01';
    return 'generic';
}

/**
 * @param {Array<Array>} data
 * @param {Object} layoutMeta
 * @returns {Object} tree_inference
 */
function inferTreeLevels(data, layoutMeta) {
    if (layoutMeta?.recommended?.profile_hint === 'uk_card') {
        return {
            profileId: 'generic',
            profileKey: null,
            levels: [],
            leaf: null,
            levelLabels: [],
            clusterCounts: {},
            confidence: 0,
            examples: [],
            hasRowOutline: Boolean(layoutMeta?.column_catalog?.has_row_outline),
            dataStartRow: layoutMeta?.column_catalog?.data_start_row ?? 0,
            summary: 'Карточка УК — фиксированные колонки, дерево не применяется',
        };
    }
    const catalog = layoutMeta?.column_catalog;
    const nameCol = catalog?.name_column?.index ?? 0;
    const dataStartRow = catalog?.data_start_row ?? 0;
    const counts = countClusters(data, nameCol);
    const profileId = detectProfileId(counts, layoutMeta);

    const profileKey =
        profileId === 'account_card' ? 'os_76_card' : profileId === 'os_08' ? 'os_08' : profileId === 'os_01' ? 'os_01' : null;
    const profile = profileKey ? getTreeProfile(profileKey) : null;

    let examples = [];
    let confidence = 0.5;

    if (profile) {
        const draftRule = applyTreeProfileToRule(
            {
                rule_schema_version: 2,
                meta: { name: 'infer', source_type: 'excel' },
                layout: { layout_type: profile.layoutType, name_column: nameCol },
                columns: [{ target: 'x', source: { type: 'hierarchy_field', field: 'path' } }],
            },
            profileKey
        );
        try {
            const walked = walkTree(data, draftRule, { treeSampleLimit: 6 });
            examples = (walked.treeSample || []).map((s) => ({
                path: s.path || [],
                leaf_name: s.leaf_name,
                text: [...(s.path || []), s.leaf_name].filter(Boolean).join(' → '),
            }));
            if (examples.length) confidence = 0.85;
        } catch {
            /* ignore */
        }
    }

    const levelLabels = profile
        ? profile.levels.map((l) => l.target || l.id)
        : Object.entries(counts)
              .filter(([, n]) => n > 0)
              .map(([id]) => CLUSTER_PATTERNS.find((c) => c.id === id)?.label || id);

    return {
        profileId,
        profileKey,
        levels: profile?.levels || [],
        leaf: profile?.leaf || null,
        levelLabels,
        clusterCounts: counts,
        confidence,
        examples,
        hasRowOutline: Boolean(catalog?.has_row_outline),
        dataStartRow,
        summary: levelLabels.length
            ? `Уровни: ${levelLabels.join(' → ')}${profile?.leaf?.level_id ? ` · лист = ${profile.leaf.level_id}` : ''}${
                  catalog?.has_row_outline ? ' · группировка Excel' : ''
              }`
            : 'Дерево не распознано',
    };
}

module.exports = { inferTreeLevels, countClusters, detectProfileId, CLUSTER_PATTERNS };
