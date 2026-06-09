const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROBE_SCRIPT = path.join(__dirname, '..', 'scripts', 'excel_probe.py');
const PROBE_EXTENSIONS = new Set(['.xlsx', '.xlsm']);

function resolvePythonLaunch() {
    const custom = process.env.PYTHON_PATH;
    if (custom) {
        return { cmd: custom, prefixArgs: [] };
    }
    if (process.platform === 'win32') {
        return { cmd: 'py', prefixArgs: ['-3'] };
    }
    return { cmd: 'python3', prefixArgs: [] };
}

function canProbeExtension(filePathOrName) {
    const ext = path.extname(String(filePathOrName || '')).toLowerCase();
    return PROBE_EXTENSIONS.has(ext);
}

function runProbeOnPath(filePath, sheetName) {
    if (!canProbeExtension(filePath)) return null;
    if (!fs.existsSync(PROBE_SCRIPT)) return null;

    const { cmd, prefixArgs } = resolvePythonLaunch();
    const args = [...prefixArgs, PROBE_SCRIPT, filePath];
    if (sheetName) args.push(sheetName);

    const result = spawnSync(cmd, args, {
        encoding: 'utf8',
        timeout: Number(process.env.EXCEL_PROBE_TIMEOUT_MS || 180000),
        maxBuffer: 50 * 1024 * 1024,
    });

    if (result.error || result.status !== 0) return null;

    try {
        const parsed = JSON.parse(String(result.stdout || '').trim());
        return parsed?.ok ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * @param {Buffer} buffer
 * @param {string} [sheetName]
 * @param {string} [fileName] — для расширения, если буфер без пути
 */
function probeExcelBuffer(buffer, sheetName, fileName = 'probe.xlsx') {
    if (!Buffer.isBuffer(buffer) || !canProbeExtension(fileName)) return null;

    const tmp = path.join(
        os.tmpdir(),
        `excel_probe_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(fileName) || '.xlsx'}`
    );

    try {
        fs.writeFileSync(tmp, buffer);
        return runProbeOnPath(tmp, sheetName);
    } catch {
        return null;
    } finally {
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* ignore */
        }
    }
}

/**
 * @param {string} filePath
 * @param {string} [sheetName]
 */
function probeExcelFile(filePath, sheetName) {
    if (!filePath || !canProbeExtension(filePath)) return null;
    return runProbeOnPath(filePath, sheetName);
}

module.exports = {
    probeExcelBuffer,
    probeExcelFile,
    canProbeExtension,
    resolvePythonLaunch,
};
