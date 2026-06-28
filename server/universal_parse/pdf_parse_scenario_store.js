const { validatePdfParseScenarioV3Full } = require('../pdf_parse_scenario_v3_validate');
const {
    buildStructuralFingerprint,
    buildDetectionHash,
} = require('./pdf_structural_fingerprint');

const PDF_PARSE_SCENARIOS_DDL = `
CREATE TABLE IF NOT EXISTS pdf_parse_scenarios (
    id SERIAL PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id),
    name TEXT NOT NULL,
    doc_kind TEXT,
    broker_subtype TEXT,
    section_id TEXT,
    rule_json JSONB NOT NULL,
    detection_hash TEXT,
    structural_fp TEXT,
    status TEXT DEFAULT 'active',
    version INTEGER DEFAULT 1,
    parent_id INTEGER REFERENCES pdf_parse_scenarios(id),
    hit_count INTEGER DEFAULT 0,
    last_hit_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pdf_parse_scenarios_lookup
    ON pdf_parse_scenarios (doc_kind, broker_subtype, section_id, status);
CREATE INDEX IF NOT EXISTS idx_pdf_parse_scenarios_structural_fp
    ON pdf_parse_scenarios (structural_fp);
`;

function rowToScenario(row) {
    if (!row) return null;
    return {
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        docKind: row.doc_kind,
        brokerSubtype: row.broker_subtype,
        sectionId: row.section_id,
        ruleJson: row.rule_json,
        detectionHash: row.detection_hash,
        structuralFp: row.structural_fp,
        status: row.status,
        version: row.version,
        parentId: row.parent_id,
        hitCount: row.hit_count,
        lastHitAt: row.last_hit_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function metaFromRule(rule) {
    const m = rule?.meta || {};
    return {
        name: m.name || 'PDF сценарий',
        docKind: m.doc_kind || null,
        brokerSubtype: m.broker_subtype || null,
        sectionId: m.section_id || null,
    };
}

/** Синонимы doc_kind: в UI/catalog — broker_pdf, в probe — broker_report. */
function docKindAliases(docKind) {
    const k = String(docKind || '').trim();
    if (!k || k === 'unknown') return null;
    if (k === 'broker_pdf' || k === 'broker_report') return ['broker_pdf', 'broker_report'];
    if (k === 'pdf_extracted' || k === 'unknown_pdf') return ['pdf_extracted', 'unknown_pdf'];
    return [k];
}

function hashesFromRule(rule) {
    const meta = metaFromRule(rule);
    const probeAtSave = rule.detection?.probe_at_save;
    const headers =
        probeAtSave?.header_sample?.length > 0
            ? probeAtSave.header_sample
            : (rule.columns || []).map((c) => c.label || c.target);
    const structuralFp =
        probeAtSave?.structural_fp ||
        buildStructuralFingerprint({
            docKind: meta.docKind,
            brokerSubtype: meta.brokerSubtype,
            sectionId: meta.sectionId,
            columnCount:
                probeAtSave?.column_count ||
                rule.columns?.length ||
                rule.validation?.expected_column_count,
            pageWidthPt: rule.layout?.page_width_pt,
            headerSample: headers,
        });
    return {
        structuralFp,
        detectionHash: buildDetectionHash(rule.detection?.markers),
    };
}

async function listPdfParseScenarios(
    pool,
    { projectId, docKind, brokerSubtype, sectionId, status = 'active', statuses = null, looseDocKind = false } = {}
) {
    const clauses = [];
    const params = [];
    let idx = 1;

    if (statuses?.length) {
        clauses.push(`status = ANY($${idx++})`);
        params.push(statuses);
    } else {
        clauses.push(`status = $${idx++}`);
        params.push(status);
    }

    const kind = docKind && docKind !== 'unknown' ? docKind : null;
    if (kind && !looseDocKind) {
        const aliases = docKindAliases(kind);
        if (aliases?.length > 1) {
            clauses.push(`(doc_kind = ANY($${idx++}) OR doc_kind IS NULL OR doc_kind = 'unknown')`);
            params.push(aliases);
        } else {
            clauses.push(`(doc_kind = $${idx++} OR doc_kind IS NULL OR doc_kind = 'unknown')`);
            params.push(kind);
        }
    }
    if (brokerSubtype && !looseDocKind) {
        clauses.push(`(broker_subtype = $${idx++} OR broker_subtype IS NULL)`);
        params.push(brokerSubtype);
    }
    if (sectionId && !looseDocKind) {
        clauses.push(`(section_id = $${idx++} OR section_id IS NULL)`);
        params.push(sectionId);
    }

    const sql = `
        SELECT * FROM pdf_parse_scenarios
        WHERE ${clauses.join(' AND ')}
        ORDER BY hit_count DESC, updated_at DESC
        LIMIT 100
    `;
    const res = await pool.query(sql, params);
    return res.rows.map(rowToScenario);
}

async function getPdfParseScenarioById(pool, id) {
    const res = await pool.query('SELECT * FROM pdf_parse_scenarios WHERE id = $1', [id]);
    return rowToScenario(res.rows[0]);
}

async function savePdfParseScenario(pool, { projectId, rule, status = 'active', parentId = null, version = 1 }) {
    const validated = validatePdfParseScenarioV3Full(rule);
    if (!validated.ok) {
        return { ok: false, errors: validated.errors };
    }

    const meta = metaFromRule(validated.rule);
    const { structuralFp, detectionHash } = hashesFromRule(validated.rule);
    const res = await pool.query(
        `INSERT INTO pdf_parse_scenarios (
            project_id, name, doc_kind, broker_subtype, section_id,
            rule_json, detection_hash, structural_fp, status, version, parent_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *`,
        [
            null,
            meta.name,
            meta.docKind,
            meta.brokerSubtype,
            meta.sectionId,
            validated.rule,
            detectionHash,
            structuralFp,
            status,
            version,
            parentId,
        ]
    );
    return { ok: true, scenario: rowToScenario(res.rows[0]) };
}

async function updatePdfParseScenarioStatus(pool, id, status) {
    const res = await pool.query(
        `UPDATE pdf_parse_scenarios
         SET status = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1
         RETURNING *`,
        [id, status]
    );
    return rowToScenario(res.rows[0]);
}

async function bumpPdfParseScenarioHit(pool, id) {
    await pool.query(
        `UPDATE pdf_parse_scenarios
         SET hit_count = COALESCE(hit_count, 0) + 1,
             last_hit_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id]
    );
}

async function findByStructuralFp(pool, structuralFp, { status = 'active', statuses = null } = {}) {
    if (statuses?.length) {
        const res = await pool.query(
            `SELECT * FROM pdf_parse_scenarios
             WHERE structural_fp = $1 AND status = ANY($2)
             ORDER BY hit_count DESC, updated_at DESC
             LIMIT 5`,
            [structuralFp, statuses]
        );
        return res.rows.map(rowToScenario);
    }
    const res = await pool.query(
        `SELECT * FROM pdf_parse_scenarios
         WHERE structural_fp = $1 AND status = $2
         ORDER BY hit_count DESC, updated_at DESC
         LIMIT 5`,
        [structuralFp, status]
    );
    return res.rows.map(rowToScenario);
}

async function recordPdfScenarioOutcome(pool, id, { success = true } = {}) {
    if (!pool || !id) return;
    const row = await getPdfParseScenarioById(pool, id);
    if (!row) return;
    const rule = { ...(row.ruleJson || {}) };
    rule.stats = rule.stats || {};
    if (success) {
        rule.stats.success_count = Number(rule.stats.success_count || 0) + 1;
    } else {
        rule.stats.failure_count = Number(rule.stats.failure_count || 0) + 1;
    }
    let nextStatus = row.status;
    const failures = rule.stats.failure_count;
    if (failures >= 3) nextStatus = 'suspended';
    else if (success && row.status === 'draft') nextStatus = 'tested';
    await pool.query(
        `UPDATE pdf_parse_scenarios
         SET rule_json = $2::jsonb, status = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [id, JSON.stringify(rule), nextStatus]
    );
}

module.exports = {
    PDF_PARSE_SCENARIOS_DDL,
    rowToScenario,
    hashesFromRule,
    listPdfParseScenarios,
    getPdfParseScenarioById,
    savePdfParseScenario,
    bumpPdfParseScenarioHit,
    findByStructuralFp,
    recordPdfScenarioOutcome,
    updatePdfParseScenarioStatus,
};
