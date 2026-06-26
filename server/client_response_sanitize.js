/**
 * Урезание ответов парса для UI: только превью строк + мета, без тяжёлого layoutMeta.
 * Полные данные — в snapshot (GET /parse/snapshots/:id/rows?page=&limit=).
 */

const CLIENT_PREVIEW_ROWS = 50;

function compactOntology(ontology) {
    if (!ontology) return null;
    return {
        row_pattern: ontology.row_pattern,
        suggested_scenario: ontology.suggested_scenario,
        suggested_structure_id: ontology.suggested_structure_id,
        account_signals: ontology.account_signals || null,
        balance_signals: ontology.balance_signals || null,
        parser_rule: ontology.parser_rule || null,
        uk_probe: ontology.uk_probe
            ? {
                  mode: ontology.uk_probe.mode,
                  skip_rows: ontology.uk_probe.skip_rows,
                  quantity_column: ontology.uk_probe.quantity_column,
                  balance_column: ontology.uk_probe.balance_column,
                  has_document_column: ontology.uk_probe.has_document_column,
              }
            : null,
    };
}

function compactStructure(structure) {
    if (!structure) return null;
    const { ranked, signals, ...rest } = structure;
    return {
        structure_id: rest.structure_id,
        confidence: rest.confidence,
        fingerprint_reason: rest.fingerprint_reason,
        ambiguous: rest.ambiguous,
        autoParse: rest.autoParse,
        alternatives: (rest.alternatives || []).slice(0, 4),
    };
}

function compactStyleHints(styleHints) {
    if (!styleHints) return null;
    return {
        large_file_mode: styleHints.large_file_mode,
        style_scan_rows: styleHints.style_scan_rows,
        likely_subtotal_count: styleHints.likely_subtotal_rows?.length ?? 0,
        hidden_row_count: styleHints.hidden_rows?.length ?? 0,
    };
}

/** Минимальный layoutMeta — только то, что нужно UI для вкладок и подсказок. */
function compactLayoutMetaForClient(layoutMeta) {
    if (!layoutMeta) return null;
    return {
        sheetNames: layoutMeta.sheetNames || [],
        sheetName: layoutMeta.sheetName || null,
        sourceFileName: layoutMeta.sourceFileName || null,
        sourceKind: layoutMeta.sourceKind || null,
        rowCount: layoutMeta.rowCount ?? null,
        recommended: layoutMeta.recommended
            ? {
                  layout_type: layoutMeta.recommended.layout_type,
                  profile_hint: layoutMeta.recommended.profile_hint,
                  confidence: layoutMeta.recommended.confidence,
                  description: layoutMeta.recommended.description,
                  fingerprint_reason: layoutMeta.recommended.fingerprint_reason,
              }
            : null,
        candidates: (layoutMeta.candidates || []).slice(0, 3),
        uk_probe: layoutMeta.uk_probe
            ? {
                  mode: layoutMeta.uk_probe.mode,
                  skip_rows: layoutMeta.uk_probe.skip_rows,
                  quantity_column: layoutMeta.uk_probe.quantity_column,
                  balance_column: layoutMeta.uk_probe.balance_column,
              }
            : null,
        ontology: compactOntology(layoutMeta.ontology),
        has_row_outline: layoutMeta.has_row_outline,
        row_outline_level_count:
            layoutMeta.row_outline_levels?.length ?? layoutMeta.row_outline_level_count ?? 0,
        excel_probe: layoutMeta.excel_probe || null,
        tree_inference: layoutMeta.tree_inference
            ? {
                  profileId: layoutMeta.tree_inference.profileId,
                  profileKey: layoutMeta.tree_inference.profileKey,
                  levelLabels: layoutMeta.tree_inference.levelLabels,
                  summary: layoutMeta.tree_inference.summary,
                  examples: (layoutMeta.tree_inference.examples || []).slice(0, 4),
              }
            : null,
        hierarchy_tree_sample: (layoutMeta.hierarchy_tree_sample || []).slice(0, 6),
    };
}

function compactParsePreview(parsePreview, limit = CLIENT_PREVIEW_ROWS) {
    if (!parsePreview) return null;
    const rowCount = parsePreview.rowCount ?? parsePreview.rows?.length ?? 0;
    return {
        ok: parsePreview.ok !== false,
        headers: parsePreview.headers || [],
        rows: (parsePreview.rows || []).slice(0, limit),
        rowCount,
        previewTruncated: rowCount > limit,
        tableMeta: parsePreview.tableMeta || null,
        scenarioId: parsePreview.scenarioId || null,
    };
}

function compactValidationReport(report) {
    if (!report) return null;
    return {
        ok: report.ok,
        level: report.level,
        summary: report.summary,
        structureId: report.structureId,
        scenarioId: report.scenarioId,
        checks: (report.checks || []).map((c) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            detail: c.detail,
        })),
    };
}

/** Правило для UI — мета и layout, без тяжёлых вложений. */
function compactRuleForClient(rule) {
    if (!rule) return null;
    return {
        rule_schema_version: rule.rule_schema_version,
        meta: rule.meta || null,
        layout: rule.layout || null,
        column_map: rule.column_map || null,
        multi_row: rule.multi_row || null,
        conditions: rule.conditions || null,
        columns: (rule.columns || []).slice(0, 40),
        output: rule.output || null,
    };
}

function compactReasoningTrace(trace) {
    if (!trace) return null;
    if (Array.isArray(trace.steps)) {
        return {
            outcome: trace.outcome || null,
            summary: trace.summary || null,
            steps: trace.steps.slice(0, 20),
        };
    }
    return {
        outcome: trace.outcome || null,
        router: trace.router
            ? {
                  scenarioId: trace.router.scenarioId,
                  confidence: trace.router.confidence,
                  source: trace.router.source,
                  fallback: trace.router.fallback,
              }
            : null,
        ontology: trace.ontology
            ? {
                  row_pattern: trace.ontology.row_pattern,
                  suggested_scenario: trace.ontology.suggested_scenario,
                  suggested_structure_id: trace.ontology.suggested_structure_id,
              }
            : null,
    };
}

function sanitizeParseApiBody(body, { previewLimit = CLIENT_PREVIEW_ROWS } = {}) {
    if (!body || typeof body !== 'object') return body;

    const layout = compactLayoutMetaForClient(body.layoutMeta || body.layoutAnalysis);

    return {
        ok: body.ok !== false,
        scenarioId: body.scenarioId || null,
        scenarioName: body.scenarioName || null,
        sourceKind: body.sourceKind || null,
        snapshotId: body.snapshotId || null,
        structureId: body.structureId || null,
        profileId: body.profileId || null,
        parsePreview: compactParsePreview(body.parsePreview, previewLimit),
        rule: compactRuleForClient(body.rule),
        layoutMeta: layout,
        layoutAnalysis: layout,
        structure: compactStructure(body.structure),
        validationReport: compactValidationReport(body.validationReport),
        warnings: (body.warnings || []).slice(0, 30),
        assistantMessage: body.assistantMessage || '',
        needsUserInput: Boolean(body.needsUserInput),
        needsScenarioChoice: Boolean(body.needsScenarioChoice),
        previewIsTentative: Boolean(body.previewIsTentative),
        userMessage: body.userMessage || '',
        staged: Boolean(body.staged),
        reasoningTrace: compactReasoningTrace(body.reasoningTrace),
        sheetNames: body.sheetNames || layout?.sheetNames || null,
        compareResult: body.compareResult || null,
        treeSample: (body.treeSample || layout?.hierarchy_tree_sample || []).slice(0, 6),
        pendingQuestions: body.pendingQuestions || [],
        currentQuestion: body.currentQuestion || null,
        sessionState: body.sessionState || null,
        candidates: body.candidates || [],
        confidence: body.confidence ?? null,
        multiSheet: body.multiSheet || false,
        snapshots: body.snapshots || null,
        parsePlan: body.parsePlan || null,
        fromInbox: body.fromInbox || false,
        responseTrimmed: body.responseTrimmed || false,
    };
}

function minimalParsePayload(slim) {
    return {
        ok: slim.ok !== false,
        scenarioId: slim.scenarioId,
        scenarioName: slim.scenarioName,
        snapshotId: slim.snapshotId,
        structureId: slim.structureId,
        parsePreview: slim.parsePreview,
        assistantMessage: slim.assistantMessage,
        validationReport: slim.validationReport
            ? { ok: slim.validationReport.ok, summary: slim.validationReport.summary }
            : null,
        warnings: (slim.warnings || []).slice(0, 10),
        responseTrimmed: true,
    };
}

/** Безопасная отдача JSON — stringify до send, не падает на глубокой вложенности. */
function safeResJson(res, payload, { previewLimit = CLIENT_PREVIEW_ROWS } = {}) {
    const slim = sanitizeParseApiBody(payload, { previewLimit });
    let json;
    try {
        json = JSON.stringify(slim);
    } catch (err) {
        console.error('[safeResJson] stringify failed:', err.message);
        try {
            json = JSON.stringify(minimalParsePayload(slim));
        } catch (err2) {
            console.error('[safeResJson] minimal stringify failed:', err2.message);
            json = JSON.stringify({
                ok: slim.ok !== false,
                snapshotId: slim.snapshotId || null,
                assistantMessage: slim.assistantMessage || 'Готово.',
                responseTrimmed: true,
            });
        }
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.send(json);
}

/** Лог в чат только после успешной отдачи HTTP-ответа. */
function safeResJsonAndLogChat(res, payload, logChatFn, opts) {
    safeResJson(res, payload, opts);
    if (!logChatFn) return;
    const run = () => logChatFn().catch((e) => console.error('[chat-log]', e.message));
    if (res.writableFinished) run();
    else res.once('finish', run);
}

module.exports = {
    CLIENT_PREVIEW_ROWS,
    compactLayoutMetaForClient,
    compactStructure,
    compactParsePreview,
    compactRuleForClient,
    compactReasoningTrace,
    sanitizeParseApiBody,
    sanitizeAutostartBody: sanitizeParseApiBody,
    safeResJson,
    safeResJsonAndLogChat,
};
