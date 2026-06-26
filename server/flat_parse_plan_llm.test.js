const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { buildFlatParseContext, shouldInvokeFlatParseLlm } = require('./universal_parse/flat_parse_plan_llm');
const { analyzeLayout } = require('./analyze_layout');
const { classifySheetStructure } = require('./structure_classifier');
const { buildExcelStructurePack } = require('./universal_parse/structure_pack');
const { applyScenario } = require('./scenarios/registry');

const FIXTURE = path.join(__dirname, 'fixtures', 'uk_card_mechel.xlsx');

describe('flat_parse_plan_llm', () => {
    it('buildFlatParseContext: uk_card fixture', () => {
        const buf = fs.readFileSync(FIXTURE);
        const layout = analyzeLayout(buf, 'TDSheet', { fileName: 'карт 58.1_mechel.xlsx' });
        const wb = xlsx.read(buf);
        const sheetData = xlsx.utils.sheet_to_json(wb.Sheets.TDSheet, { header: 1, defval: '' });
        const structure = classifySheetStructure(sheetData, { layoutMeta: layout });
        const flat = buildFlatParseContext({
            layoutMeta: layout,
            data: sheetData,
            structure,
            file: { originalname: 'карт 58.1_mechel.xlsx' },
            scenarioId: 'uk_card',
        });
        assert.equal(flat.scenarioId, 'uk_card');
        assert.equal(flat.ontology.row_pattern, 'bu_kol_pairs');
        assert.ok(flat.probe_hypothesis);
        assert.ok(flat.preview_header?.length > 0);
    });

    it('shouldInvokeFlatParseLlm: off when MARTIN_FLAT_PARSE_LLM=off', () => {
        const prev = process.env.MARTIN_FLAT_PARSE_LLM;
        process.env.MARTIN_FLAT_PARSE_LLM = 'off';
        try {
            const buf = fs.readFileSync(FIXTURE);
            const layout = analyzeLayout(buf, 'TDSheet', { fileName: 'x.xlsx' });
            const wb = xlsx.read(buf);
            const data = xlsx.utils.sheet_to_json(wb.Sheets.TDSheet, { header: 1, defval: '' });
            const structure = classifySheetStructure(data, { layoutMeta: layout });
            const structurePack = buildExcelStructurePack({
                layoutMeta: layout,
                data,
                structure,
                file: { originalname: 'x.xlsx' },
            });
            const ctx = { layoutMeta: layout, data, structure, structurePack };
            const baseRule = applyScenario('uk_card', layout);
            assert.equal(shouldInvokeFlatParseLlm(ctx, 'uk_card', baseRule), false);
        } finally {
            if (prev === undefined) delete process.env.MARTIN_FLAT_PARSE_LLM;
            else process.env.MARTIN_FLAT_PARSE_LLM = prev;
        }
    });
});
