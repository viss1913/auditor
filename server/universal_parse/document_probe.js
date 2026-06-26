const { detectSourceKind } = require('../file_dispatch');
const { analyzeLayout } = require('../analyze_layout');
const { buildLayoutFingerprint } = require('../layout_fingerprint');
const { probePdfKind } = require('../pdf_probe');
const { pickPreferredSheet } = require('../excel_sheet_meta');
const { listSheetNames } = require('../excel_preview');
const { buildStructurePack } = require('./structure_pack');
const { fingerprintHash } = require('./rule_cache');

async function probeDocument(buffer, fileName, options = {}) {
    const sourceKind = detectSourceKind(fileName);
    const result = {
        sourceKind,
        fileName,
        fingerprint: null,
        fingerprintHash: null,
        candidates: [],
        layoutMeta: null,
        pdfProbe: null,
        lines: [],
        structurePack: null,
    };

    if (sourceKind === 'excel') {
        const { sheetNames } = listSheetNames(buffer);
        const sheetName = pickPreferredSheet(sheetNames, options.sheetName);
        const layoutMeta = analyzeLayout(buffer, sheetName, { fileName });
        layoutMeta.sourceFileName = fileName;
        layoutMeta.sourceKind = 'excel';
        result.layoutMeta = layoutMeta;
        result.candidates = layoutMeta.candidates || [];
        result.fingerprint = layoutMeta.layout_fingerprint || buildLayoutFingerprint(
            [],
            { fileName, sheetName }
        );
        result.fingerprintHash = fingerprintHash(result.fingerprint);
        result.structurePack = buildStructurePack(result, options);
        return result;
    }

    if (sourceKind === 'pdf') {
        const pdfProbe = await probePdfKind(buffer, fileName);
        result.pdfProbe = pdfProbe;
        result.lines = pdfProbe.lines || [];
        result.fingerprint = {
            sourceKind: 'pdf',
            pdfKind: pdfProbe.kind,
            lineCount: pdfProbe.lineCount,
            pageCount: pdfProbe.pageCount,
        };
        result.fingerprintHash = fingerprintHash(result.fingerprint);
        result.candidates = [
            {
                profile_hint: pdfProbe.kind === 'broker_report' ? 'broker_pdf' : pdfProbe.kind,
                confidence: pdfProbe.confidence,
                layout_type: 'fixed_rows',
                description: `PDF: ${pdfProbe.kind}`,
            },
        ];
        result.layoutMeta = {
            sourceKind: 'pdf',
            sourceFileName: fileName,
            recommended: result.candidates[0] || null,
            pdfProbe,
        };
        result.structurePack = buildStructurePack(result, options);
        return result;
    }

    if (sourceKind === 'text_1c') {
        const text = buffer.toString('utf8');
        result.lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        result.fingerprint = { sourceKind: 'text_1c', lineCount: result.lines.length };
        result.fingerprintHash = fingerprintHash(result.fingerprint);
        result.structurePack = buildStructurePack(result, options);
        return result;
    }

    if (sourceKind === 'image_scan') {
        result.fingerprint = { sourceKind: 'image_scan', fileName };
        result.fingerprintHash = fingerprintHash(result.fingerprint);
        result.candidates = [
            {
                profile_hint: 'document_scan',
                confidence: 0.5,
                layout_type: 'vision_ocr',
                description: 'Скан / фото документа',
            },
        ];
        result.layoutMeta = {
            sourceKind: 'image_scan',
            sourceFileName: fileName,
            recommended: result.candidates[0],
        };
        result.structurePack = buildStructurePack(result, options);
        return result;
    }

    result.structurePack = buildStructurePack(result, options);
    return result;
}

module.exports = { probeDocument };
