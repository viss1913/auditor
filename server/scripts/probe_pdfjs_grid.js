/**
 * Отладка grid-извлечения: node scripts/probe_pdfjs_grid.js <pdf> [sectionId]
 */
const fs = require('fs');
const path = require('path');
const { SECTION_DEFS } = require('../universal_parse/pdf_broker_sections');
const { extractSectionsFromGrid, extractTableGridFromPdf } = require('../universal_parse/pdfjs_table_grid_extract');

async function main() {
    const pdfPath = process.argv[2];
    const sectionId = process.argv[3] || null;
    if (!pdfPath) {
        console.error('Usage: node scripts/probe_pdfjs_grid.js <pdf> [sectionId]');
        process.exit(1);
    }
    const abs = path.resolve(pdfPath);
    const buf = fs.readFileSync(abs);
    const name = path.basename(abs);

    if (sectionId) {
        const def = SECTION_DEFS.find((d) => d.id === sectionId);
        if (!def) {
            console.error('Unknown section:', sectionId);
            process.exit(1);
        }
        const out = await extractTableGridFromPdf(buf, { anchorStart: def.patterns[0] });
        console.log(JSON.stringify({ file: name, section: def.id, ...out }, null, 2));
        return;
    }

    const sections = await extractSectionsFromGrid(buf, SECTION_DEFS);
    const summary = sections.map((s) => ({
        id: s.id,
        label: s.label,
        method: s.method,
        confidence: s.confidence,
        headers: s.headers,
        rowCount: s.rows.length,
        sample: s.rows.slice(0, 2),
    }));
    console.log(JSON.stringify({ file: name, sections: summary }, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
