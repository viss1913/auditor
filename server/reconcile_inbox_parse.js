const fs = require('fs');
const path = require('path');
const { analyzeLayout } = require('./analyze_layout');
const { applyScenario } = require('./scenarios/registry');
const { runParseEngine } = require('./parse_engine');
const { resolveScenarioFromOntology } = require('./structure_ontology');

function resolveScenarioFromLayout(layout) {
    const meta = layout?.layoutMeta || layout;
    return (
        meta?.recommended?.scenario_id ||
        meta?.recommended?.profile_hint ||
        resolveScenarioFromOntology(meta?.ontology) ||
        'uk_card'
    );
}

/**
 * Быстрый парс одного файла из inbox в плоскую таблицу (без UI).
 */
function parseInboxFileToTable(absolutePath, fileName) {
    const buf = fs.readFileSync(absolutePath);
    const layout = analyzeLayout(buf, null, { fileName: fileName || path.basename(absolutePath) });
    const scenarioId = resolveScenarioFromLayout(layout);
    const rule = applyScenario(scenarioId, layout.layoutMeta || layout);
    const out = runParseEngine(absolutePath, rule);
    if (!out?.ok) {
        throw new Error((out?.errors || ['Парс не удался']).join('; '));
    }
    return {
        headers: out.headers || [],
        rows: out.rows || [],
        label: fileName || path.basename(absolutePath),
        scenarioId,
    };
}

module.exports = { parseInboxFileToTable, resolveScenarioFromLayout };
