/**
 * Одноразовый импорт sectionLayout:* из rule_cache.json в pdf_parse_scenarios.
 * Запуск: node server/scripts/migrate_rule_cache_to_pdf_scenarios.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { CACHE_PATH } = require('../universal_parse/rule_cache');
const { PDF_PARSE_SCENARIOS_DDL, savePdfParseScenario } = require('../universal_parse/pdf_parse_scenario_store');
const { centersToNorm } = require('../universal_parse/pdf_parse_scenario_coords');

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'auditor',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '1qazXSW@',
});

function parseSectionLayoutKey(key) {
    const m = /^sectionLayout:([^:]+):([^:]+)(?::(.+))?$/.exec(key);
    if (!m) return null;
    return { brokerSubtype: m[1], sectionId: m[2], fileFp: m[3] || null };
}

async function main() {
    await pool.query(PDF_PARSE_SCENARIOS_DDL);

    let cache = {};
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch {
        console.log('rule_cache.json пуст или не найден');
        await pool.end();
        return;
    }

    let imported = 0;
    let skipped = 0;

    for (const [key, entry] of Object.entries(cache)) {
        if (!key.startsWith('sectionLayout:')) continue;
        const parsed = parseSectionLayoutKey(key);
        if (!parsed || parsed.fileFp) {
            skipped++;
            continue;
        }
        if (!entry?.columnCenters?.length || !entry?.headers?.length) {
            skipped++;
            continue;
        }

        const pageW = Math.max(
            595.28,
            ...(entry.columnCenters || []).map((x) => Number(x) || 0),
            1
        ) * 1.02;
        const norms = centersToNorm(entry.columnCenters, pageW);
        const rule = {
            rule_schema_version: 3,
            meta: {
                name: `${parsed.brokerSubtype.toUpperCase()} — ${parsed.sectionId}`,
                source_type: 'pdf',
                doc_kind: 'broker_report',
                broker_subtype: parsed.brokerSubtype,
                section_id: parsed.sectionId,
                description: `Импорт из rule_cache (${key})`,
            },
            detection: {
                markers: [parsed.sectionId.replace(/_/g, ' ')],
                min_marker_hits: 1,
            },
            layout: {
                engine: 'pdfjs_grid',
                page_width_pt: pageW,
                data_start_row: entry.dataStart ?? 0,
                header_row_count: entry.headerRowCount ?? 0,
                x_tol_norm: (entry.xTol || 40) / pageW,
            },
            columns: entry.headers.map((label, index) => ({
                index,
                target: String(label || `col_${index + 1}`)
                    .toLowerCase()
                    .replace(/[^\p{L}\p{N}]+/gu, '_')
                    .slice(0, 64) || `col_${index + 1}`,
                label: String(label || `col_${index + 1}`),
                description: '',
                center_norm: norms[index] ?? norms[norms.length - 1],
                type: 'text',
            })),
            validation: {
                expected_column_count: entry.headers.length,
            },
        };

        const saved = await savePdfParseScenario(pool, { rule, status: 'active' });
        if (saved.ok) {
            imported++;
            console.log(`OK #${saved.scenario.id} ${rule.meta.name}`);
        } else {
            console.warn(`SKIP ${key}:`, saved.errors?.join('; '));
            skipped++;
        }
    }

    console.log(`Готово: импортировано ${imported}, пропущено ${skipped}`);
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
