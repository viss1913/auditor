const { headerMatchScore, columnStructureScore } = require('./pdf_scenario_quality');

function normalizeHeader(h) {
    return String(h || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
}

function rowSignature(row, headers) {
    return (headers || [])
        .map((h) => String(row?.[h] ?? '').trim())
        .join('|');
}

/**
 * Сравнение auto-grid vs scenario-grid для Diff UI и orchestrator.
 */
function computeGridDiff(autoGrid, scenarioGrid, signals = {}) {
    const autoHeaders = autoGrid?.headers || [];
    const scenHeaders = scenarioGrid?.headers || [];
    const autoRows = autoGrid?.rows || [];
    const scenRows = scenarioGrid?.rows || [];

    const autoCols = autoHeaders.length;
    const scenCols = scenHeaders.length;
    const rowCountDelta = autoRows.length - scenRows.length;
    const columnCountDelta = autoCols - scenCols;

    const headerMatch = headerMatchScore(
        { headerSample: autoHeaders.slice(0, 3) },
        { ruleJson: { columns: scenHeaders.map((h) => ({ label: h })) } }
    );
    const structureMatch = columnStructureScore(signals, {
        ruleJson: {
            validation: { expected_column_count: scenCols },
            columns: scenHeaders.map((h) => ({ label: h })),
        },
    });

    const sampleDiffs = [];
    const maxSample = Math.min(8, autoRows.length, scenRows.length);
    for (let i = 0; i < maxSample; i++) {
        const aSig = rowSignature(autoRows[i], autoHeaders);
        const sSig = rowSignature(scenRows[i], scenHeaders);
        if (aSig !== sSig) {
            sampleDiffs.push({
                rowIndex: i,
                auto: autoRows[i],
                scenario: scenRows[i],
            });
        }
    }

    let recommendedSource = 'auto';
    if (scenCols > autoCols + 1) recommendedSource = 'scenario';
    else if (autoCols > scenCols + 1) recommendedSource = 'auto';
    else if (scenRows.length > autoRows.length + 2) recommendedSource = 'scenario';
    else if (autoRows.length > scenRows.length + 2) recommendedSource = 'auto';
    else if (headerMatch < 0.5 && structureMatch >= 0.75) recommendedSource = 'scenario';

    const matchScore = Math.round((0.55 * headerMatch + 0.45 * structureMatch) * 1000) / 1000;

    return {
        auto: {
            columns: autoCols,
            rows: autoRows.length,
            headers: autoHeaders,
            confidence: autoGrid?.confidence ?? null,
        },
        scenario: {
            columns: scenCols,
            rows: scenRows.length,
            headers: scenHeaders,
            confidence: scenarioGrid?.confidence ?? null,
            scenarioId: signals.scenarioId ?? null,
            scenarioName: signals.scenarioName ?? null,
            scenarioVersion: signals.scenarioVersion ?? null,
        },
        columnCountDelta,
        rowCountDelta,
        headerMatchScore: headerMatch,
        structureMatchScore: structureMatch,
        matchScore,
        sampleDiffs,
        hasDiff: columnCountDelta !== 0 || rowCountDelta !== 0 || sampleDiffs.length > 0,
        recommendedSource,
    };
}

module.exports = {
    computeGridDiff,
};
