const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const EGRUL_ROOT = process.env.AUDITOR_EGRUL_ROOT
    ? path.resolve(process.env.AUDITOR_EGRUL_ROOT)
    : path.join(__dirname, 'data', 'egrul');

function toPosixRelative(absPath) {
    return path.relative(PROJECT_ROOT, absPath).split(path.sep).join('/');
}

/**
 * Папка для одной проверки (один запрос из чата / один snapshot).
 * @param {{ snapshotId?: number|null }} [opts]
 */
function createEgrulBatchDir(opts = {}) {
    const datePart = new Date().toISOString().slice(0, 10);
    const batchName = opts.snapshotId
        ? `snapshot-${opts.snapshotId}`
        : `run-${Date.now()}`;
    const dir = path.join(EGRUL_ROOT, datePart, batchName);
    fs.mkdirSync(dir, { recursive: true });
    return {
        absDir: dir,
        relativeDir: toPosixRelative(dir),
        batchName,
        datePart,
    };
}

/**
 * @param {Buffer} pdfBuffer
 * @param {{ inn: string, ogrn?: string, batchDir: string }} opts
 */
function saveEgrulPdf(pdfBuffer, { inn, ogrn, batchDir }) {
    const safeInn = String(inn || '').replace(/\D/g, '') || 'unknown';
    const safeOgrn = String(ogrn || 'no-ogrn').replace(/[^\dA-Za-z_-]/g, '') || 'no-ogrn';
    const fileName = `EGRUL_${safeInn}_${safeOgrn}.pdf`;
    const absPath = path.join(batchDir, fileName);
    fs.writeFileSync(absPath, pdfBuffer);
    return {
        absPath,
        relativePath: toPosixRelative(absPath),
        fileName,
    };
}

function getEgrulRootRelative() {
    return toPosixRelative(EGRUL_ROOT);
}

module.exports = {
    EGRUL_ROOT,
    PROJECT_ROOT,
    createEgrulBatchDir,
    saveEgrulPdf,
    getEgrulRootRelative,
    toPosixRelative,
};
