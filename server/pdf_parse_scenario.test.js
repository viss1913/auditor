const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validatePdfParseScenarioV3 } = require('./pdf_parse_scenario_v3_validate');
const {
    centersToNorm,
    centersFromNorm,
    extractLayoutFromScenario,
} = require('./universal_parse/pdf_parse_scenario_coords');
const {
    buildStructuralFingerprint,
    headerSimilarity,
    scoreScenarioMatch,
    matchStatusFromScore,
} = require('./universal_parse/pdf_structural_fingerprint');

test('validatePdfParseScenarioV3 accepts minimal grid rule', () => {
    const rule = {
        rule_schema_version: 3,
        meta: { name: 'Test', source_type: 'pdf', doc_kind: 'broker_report' },
        layout: { engine: 'pdfjs_grid', page_width_pt: 595, x_tol_norm: 0.02 },
        columns: [
            { index: 0, target: 'date', label: 'Дата', center_norm: 0.1, type: 'date' },
            { index: 1, target: 'isin', label: 'ISIN', center_norm: 0.5, type: 'text' },
        ],
    };
    const v = validatePdfParseScenarioV3(rule);
    assert.equal(v.ok, true);
});

test('centers norm roundtrip', () => {
    const centers = [30, 120, 400];
    const norms = centersToNorm(centers, 600);
    const back = centersFromNorm(norms, 600);
    assert.ok(Math.abs(back[0] - 30) < 0.01);
    assert.ok(Math.abs(back[2] - 400) < 0.01);
});

test('extractLayoutFromScenario restores centers', () => {
    const rule = {
        layout: { page_width_pt: 500, x_tol_norm: 0.04, data_start_row: 2 },
        columns: [
            { index: 0, target: 'a', label: 'A', center_norm: 0.2 },
            { index: 1, target: 'b', label: 'B', center_norm: 0.8 },
        ],
    };
    const layout = extractLayoutFromScenario(rule);
    assert.equal(layout.columnCenters.length, 2);
    assert.ok(Math.abs(layout.columnCenters[0] - 100) < 0.01);
    assert.equal(layout.dataStart, 2);
});

test('structural fingerprint stable for same headers', () => {
    const a = buildStructuralFingerprint({
        docKind: 'broker_report',
        brokerSubtype: 'aton',
        sectionId: 'trades',
        columnCount: 21,
        pageWidthPt: 595,
        headerSample: ['Дата', 'ISIN', 'Количество'],
    });
    const b = buildStructuralFingerprint({
        docKind: 'broker_report',
        brokerSubtype: 'aton',
        sectionId: 'trades',
        columnCount: 21,
        pageWidthPt: 595,
        headerSample: ['Дата', 'ISIN', 'Количество'],
    });
    assert.equal(a, b);
});

test('scoreScenarioMatch found threshold', () => {
    const rule = {
        detection: { markers: ['aton', 'исполненные'], min_marker_hits: 1 },
        columns: [
            { label: 'Дата', target: 'date' },
            { label: 'ISIN', target: 'isin' },
            { label: 'Кол-во', target: 'qty' },
        ],
        layout: { page_width_pt: 595 },
        validation: { expected_column_count: 3 },
    };
    const scored = scoreScenarioMatch(
        {
            text: 'ATON исполненные сделки',
            headerSample: ['Дата', 'ISIN', 'Кол-во'],
            columnCount: 3,
            pageWidthPt: 595,
        },
        { rule_json: rule }
    );
    assert.ok(scored.score >= 0.85);
    assert.equal(matchStatusFromScore(scored.score), 'found');
});

test('headerSimilarity partial', () => {
    const sim = headerSimilarity(['Дата сделки', 'ISIN'], ['Дата сделки', 'ISIN код']);
    assert.ok(sim >= 0.5);
});
