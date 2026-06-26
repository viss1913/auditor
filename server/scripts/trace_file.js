#!/usr/bin/env node
/**
 * Пошаговая трассировка парса одного файла (без UI).
 * node scripts/trace_file.js "path/to/file.xlsx" ["сообщение в чат"]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { listSheetNames } = require('../excel_preview');
const { analyzeLayout } = require('../analyze_layout');
const { readSheetWithMeta } = require('../excel_sheet_meta');
const { probeExcelFile } = require('../excel_probe_bridge');
const { classifySheetStructure } = require('../structure_classifier');
const { resolveUpload } = require('../scenario_router');
const { buildSessionPlan } = require('../orchestrator/session_plan');
const { buildParsePlan } = require('../orchestrator/parse_plan');
const { buildReasoningTrace } = require('../reasoning_trace');
const { applyScenario } = require('../scenarios/registry');
const { runParsePreview, withTempFile } = require('../parse_preview');
const { buildExcelStructurePack } = require('../universal_parse/structure_pack');
const { isLlmRouterEnabled } = require('../martin_flags');

const filePath = process.argv[2];
const userMessage = process.argv[3] || '';

if (!filePath || !fs.existsSync(filePath)) {
    console.error('Usage: node scripts/trace_file.js <file.xlsx> [userMessage]');
    process.exit(1);
}

function section(title, data) {
    console.log('\n' + '='.repeat(72));
    console.log(`### ${title}`);
    console.log('='.repeat(72));
    console.log(JSON.stringify(data, null, 2));
}

(async () => {
    const buf = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const sizeKb = Math.round(buf.length / 1024);

    section('0. Вход', { fileName, sizeKb, userMessage: userMessage || '(пусто — авто)' });

    const { sheetNames, defaultSheet } = listSheetNames(buf);
    section('1. Листы (SheetJS)', { sheetNames, defaultSheet });

    const openpyxlProbe = probeExcelFile(filePath, defaultSheet);
    section('2. Openpyxl-probe (структура Excel)', openpyxlProbe || { skipped: true });

    const sheetMeta = readSheetWithMeta(buf, { fileName, sheetName: defaultSheet });
    section('3. readSheetWithMeta (мержи, outline, sample)', {
        sheetName: sheetMeta.sheetName,
        rowCount: sheetMeta.rowCount,
        colCount: sheetMeta.colCount,
        hasOutline: sheetMeta.hasOutline,
        mergedCount: sheetMeta.mergedRanges?.length ?? 0,
        previewRows: (sheetMeta.data || []).slice(0, 8).map((r) =>
            (r || []).slice(0, 10).map((c) => String(c ?? '').slice(0, 40))
        ),
    });

    const layoutMeta = analyzeLayout(buf, defaultSheet, {
        fileName,
        useExcelProbe: true,
        loaded: sheetMeta,
    });
    layoutMeta.sourceFileName = fileName;
    const data = sheetMeta.data || [];

    section('4. analyzeLayout (fingerprint UK/дерево)', {
        sheetName: layoutMeta.sheetName,
        recommended: layoutMeta.recommended,
        uk_probe: layoutMeta.uk_probe,
        tree_inference: layoutMeta.tree_inference
            ? {
                  examples: layoutMeta.tree_inference.examples?.slice(0, 5),
                  clusterCounts: layoutMeta.tree_inference.clusterCounts,
              }
            : null,
        previewText: String(layoutMeta.previewText || '').slice(0, 600),
    });

    const structure = classifySheetStructure(data, {
        hasOutline: sheetMeta.hasOutline,
        rowOutlineLevels: sheetMeta.rowOutlineLevels,
        mergedRanges: sheetMeta.mergedRanges,
        layoutMeta,
    });
    section('5. classifySheetStructure', {
        structure_id: structure.structure_id,
        confidence: structure.confidence,
        ambiguous: structure.ambiguous,
        autoParse: structure.autoParse,
        fingerprint_reason: structure.fingerprint_reason,
        alternatives: structure.alternatives?.slice(0, 5),
    });

    const structurePack = buildExcelStructurePack({
        layoutMeta,
        data,
        structure,
        sheetMeta,
        file: { buffer: buf, originalname: fileName },
    });
    section('6. structurePack (контекст для LLM-router)', {
        llmRouterEnabled: isLlmRouterEnabled(),
        packKeys: Object.keys(structurePack),
        summary: structurePack.summary || structurePack.classifier_hint,
        preview_tsv_head: String(structurePack.preview_tsv || '').slice(0, 800),
    });

    const probe = {
        fileCount: 1,
        totalFiles: 1,
        sampleNames: [fileName],
        suggestedScenario: null,
        byKind: { excel: 1 },
    };
    const parsePlan = buildParsePlan(userMessage, {
        fileMetas: [{ name: fileName, relativePath: fileName }],
        probe,
        layoutMeta,
        orchestratorAnswers: {},
    });
    section('7. parsePlan (команда → intent)', parsePlan);

    const routed = await resolveUpload({
        buffer: buf,
        fileName,
        sheetName: defaultSheet,
        orchestratorAnswers: parsePlan.scenarioId ? { scenarioId: parsePlan.scenarioId } : {},
    });
    section('8. scenario_router.resolveUpload', {
        ok: routed.ok,
        route: routed.route,
        scenarioId: routed.scenarioId,
        needsTreeConfirm: routed.needsTreeConfirm,
        needsUserChoice: routed.needsUserChoice,
        errors: routed.errors,
    });

    if (!routed.ok) {
        process.exit(1);
    }

    const sessionPlan = buildSessionPlan(routed.layoutMeta, null, null, {
        scenarioIdParam: routed.scenarioId,
        answers: {},
        savedRules: [],
    });
    section('9. sessionPlan (вопросы пользователю)', {
        needsUserInput: sessionPlan.needsUserInput,
        pendingQuestions: sessionPlan.pendingQuestions,
        scenarioId: sessionPlan.scenarioId,
    });

    const rule = applyScenario(routed.scenarioId, routed.layoutMeta, null);
    const preview = withTempFile(buf, fileName, (tmp) =>
        runParsePreview(tmp, rule, 15)
    );
    section('10. parsePreview (первые строки таблицы)', {
        ok: preview.ok,
        rowCount: preview.rowCount,
        headers: preview.headers,
        rows: preview.rows?.slice(0, 5),
        warnings: preview.warnings,
    });

    const trace = buildReasoningTrace({
        parsePlan,
        structure,
        scenarioId: routed.scenarioId,
        sheetName: defaultSheet,
        fileName,
        rowCount: preview.rowCount,
        outcome: preview.ok ? 'success' : 'refused',
    });
    section('11. reasoningTrace (что увидишь в UI «Как решила»)', trace);

    console.log('\n✓ Готово\n');
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
