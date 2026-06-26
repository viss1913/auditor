/**
 * Единые пороги confidence для PDF/parse pipeline.
 * PDF_VALIDATION_STRICT=1 — блокировать snapshot при fail validation.
 */

const PDF_VALIDATION_STRICT =
    String(process.env.PDF_VALIDATION_STRICT || '0').trim() === '1';

module.exports = {
    CLASSIFY_MIN_MARGIN: 1,
    IMPORT_MIN_CONFIDENCE: 0.75,
    GRID_MIN_CONFIDENCE: 0.65,
    HIGH_CONFIDENCE: 0.85,
    PDF_VALIDATION_STRICT,
    DUAL_EXTRACT_HEADER_OVERLAP_MIN: 0.5,
};
