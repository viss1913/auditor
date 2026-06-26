#!/usr/bin/env node
/**
 * Инвентаризация брокерских PDF в папке SOLAR (Ксения).
 * node scripts/audit_broker_pdfs.js [папка]
 */
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { probePdfKind, detectBrokerSubtype } = require('../pdf_probe');
const {
    findSectionStarts,
    extractBrokerPdfSectionTables,
} = require('../universal_parse/pdf_broker_sections');
const { extractPdfTablesFromLines } = require('../universal_parse/pdf_table_extract');

const DEFAULT_ROOT = path.join(
    __dirname,
    '..',
    '..',
    'docs',
    'ksenia',
    'проект SOLAR'
);

function walkPdfs(dir, acc = []) {
    if (!fs.existsSync(dir)) return acc;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walkPdfs(full, acc);
        else if (ent.isFile() && /\.pdf$/i.test(ent.name)) acc.push(full);
    }
    return acc.sort();
}

function relPath(full, root) {
    return path.relative(root, full).replace(/\\/g, '/');
}

async function auditLegacySections(lines, pdfBuffer) {
    return extractBrokerPdfSectionTables(lines, '', { brokerSubtype: 'unknown', pdfBuffer });
}

async function auditAtonSections(lines, pdfBuffer) {
    return extractBrokerPdfSectionTables(lines, '', { brokerSubtype: 'aton', pdfBuffer });
}

function sectionSummary(sections) {
    return sections.map((s) => `${s.id}:${s.rows.length}[${s.method || '?'}:${s.headers?.length || 0}c]`).join(', ') || '—';
}

async function auditOne(filePath, root) {
    const buf = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const probe = await probePdfKind(buf, fileName);
    const subtype = detectBrokerSubtype(probe.lines.join('\n'), fileName, filePath);
    const starts = findSectionStarts(probe.lines || []);
    const legacy = await auditLegacySections(probe.lines || [], buf);
    const aton =
        subtype === 'aton' ? await auditAtonSections(probe.lines || [], buf) : [];
    const wholeHeuristic = extractPdfTablesFromLines(probe.lines || []);

    return {
        file: relPath(filePath, root),
        fileName,
        kind: probe.kind,
        confidence: probe.confidence,
        brokerSubtype: subtype,
        lineCount: probe.lineCount,
        pageCount: probe.pageCount,
        sectionsFound: starts.map((s) => s.def.id).join(', ') || '—',
        legacyExtract: sectionSummary(legacy),
        atonExtract: sectionSummary(aton),
        atonTableCount: aton.length,
        wholeHeuristicRows: wholeHeuristic.ok ? wholeHeuristic.rows.length : 0,
        ok:
            subtype === 'not_broker' ||
            (subtype === 'aton' && aton.length >= 2) ||
            (subtype !== 'aton' && probe.kind === 'broker_report' && legacy.length >= 1),
    };
}

function toMarkdown(rows, root) {
    const lines = [
        '# Инвентарь брокерских PDF (SOLAR / Ксения)',
        '',
        `Сгенерировано: ${new Date().toISOString()}`,
        '',
        `Корень: \`${root.replace(/\\/g, '/')}\``,
        '',
        `Всего PDF: **${rows.length}**`,
        '',
        '| Файл | kind | subtype | разделы | legacy | ATON extract | OK |',
        '|------|------|---------|---------|--------|--------------|-----|',
    ];

    for (const r of rows) {
        lines.push(
            `| \`${r.file}\` | ${r.kind} | ${r.brokerSubtype} | ${r.sectionsFound} | ${r.legacyExtract} | ${r.atonExtract || '—'} | ${r.ok ? 'да' : 'нет'} |`
        );
    }

    lines.push('', '## Детали', '');
    for (const r of rows) {
        lines.push(`### ${r.fileName}`, '');
        lines.push(`- kind: \`${r.kind}\`, subtype: \`${r.brokerSubtype}\`, строк: ${r.lineCount}, страниц: ${r.pageCount}`);
        lines.push(`- разделы: ${r.sectionsFound}`);
        lines.push(`- legacy extract: ${r.legacyExtract}`);
        lines.push(`- ATON extract: ${r.atonExtract || '—'} (${r.atonTableCount} табл.)`);
        lines.push(`- эвристика на весь PDF: ${r.wholeHeuristicRows} строк`);
        lines.push('');
    }

    return lines.join('\n');
}

(async () => {
    const root = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_ROOT;
    const pdfs = walkPdfs(root);
    if (!pdfs.length) {
        console.error('PDF не найдены в', root);
        process.exit(1);
    }

    const results = [];
    for (const pdf of pdfs) {
        process.stderr.write(`audit: ${path.basename(pdf)}\n`);
        results.push(await auditOne(pdf, root));
    }

    const outMd = path.join(__dirname, '..', '..', 'docs', 'ksenia', 'BROKER_PDF_INVENTORY.md');
    const outJson = path.join(__dirname, '..', '..', 'docs', 'ksenia', 'BROKER_PDF_INVENTORY.json');
    fs.writeFileSync(outMd, toMarkdown(results, root), 'utf8');
    fs.writeFileSync(outJson, JSON.stringify({ root, generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');

    const atonOk = results.filter((r) => r.brokerSubtype === 'aton' && r.ok).length;
    const atonTotal = results.filter((r) => r.brokerSubtype === 'aton').length;
    console.log(JSON.stringify({ total: results.length, atonOk, atonTotal, outMd }, null, 2));
})();
