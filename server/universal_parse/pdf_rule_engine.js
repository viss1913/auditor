const { parseUpdFromLines } = require('../parse_upd_pdf');

function extractAnchors(lines, anchors = {}) {
    const out = {};
    const joined = lines.join('\n');
    for (const [key, spec] of Object.entries(anchors)) {
        if (spec.pattern) {
            const m = new RegExp(spec.pattern, 'i').exec(joined);
            out[key] = m ? m[1] || m[0] : '';
        } else if (spec.after_label) {
            const idx = lines.findIndex((l) => l === spec.after_label || l.startsWith(spec.after_label));
            out[key] = idx >= 0 ? lines[idx + (spec.offset ?? 1)] || '' : '';
        }
    }
    return out;
}

/**
 * MVP: upd_ediweb profile_hint → встроенный парсер; иначе anchors + regex_rows.
 */
function executePdfExtractionRule(lines, rule) {
    const hint = rule?.meta?.profile_hint;
    if (hint === 'upd_ediweb' || rule?.meta?.name === 'upd_ediweb') {
        const parsed = parseUpdFromLines(lines);
        return {
            ok: parsed.ok,
            tables: {
                line_items: { headers: parsed.headers, rows: parsed.rows },
                doc_header: parsed.doc_header,
                totals: parsed.totals,
            },
            primaryTable: 'line_items',
        };
    }

    const anchors = extractAnchors(lines, rule.anchors || {});
    const tables = { anchors };

    for (const tableSpec of rule.tables || []) {
        if (tableSpec.row_mode === 'regex_rows' && tableSpec.steps?.length) {
            const rows = [];
            for (const line of lines) {
                for (const step of tableSpec.steps) {
                    if (!step.match) continue;
                    const m = new RegExp(step.match).exec(line);
                    if (!m) continue;
                    const row = {};
                    for (const [field, gi] of Object.entries(step.capture || {})) {
                        row[field] = m[Number(gi)] ?? m[0];
                    }
                    rows.push(row);
                    break;
                }
            }
            tables[tableSpec.id] = { rows };
        }
    }

    const primary = rule.tables?.[0]?.id;
    return {
        ok: Boolean(primary && tables[primary]?.rows?.length),
        tables,
        primaryTable: primary,
    };
}

module.exports = { executePdfExtractionRule, extractAnchors };
