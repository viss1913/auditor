function buildReplaceMap(mappings) {
    const map = new Map();
    for (const { from, to } of mappings || []) {
        map.set(String(from).trim(), String(to).trim());
    }
    return map;
}

function buildReplaceAssistantMessage(column, mappings, changedCells) {
    const rules = (mappings || []).map((m) => `«${m.from}» → «${m.to}»`).join(', ');
    return `Заменила в «${column}»: ${rules} (${changedCells} ячеек).`;
}

module.exports = {
    buildReplaceMap,
    buildReplaceAssistantMessage,
};
