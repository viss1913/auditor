const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'rule_cache.json');

function ensureCacheFile() {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CACHE_PATH)) fs.writeFileSync(CACHE_PATH, '{}', 'utf8');
}

function fingerprintHash(fingerprint) {
    const payload = JSON.stringify(fingerprint || {});
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 24);
}

function readCache() {
    ensureCacheFile();
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function writeCache(data) {
    ensureCacheFile();
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getCachedRule(fingerprint, profileHint = '') {
    const key = `${fingerprintHash(fingerprint)}:${profileHint || '*'}`;
    const all = readCache();
    return all[key]?.rule || null;
}

function setCachedRule(fingerprint, rule, profileHint = '') {
    const key = `${fingerprintHash(fingerprint)}:${profileHint || '*'}`;
    const all = readCache();
    all[key] = {
        rule,
        profileHint,
        savedAt: new Date().toISOString(),
        fingerprintHash: fingerprintHash(fingerprint),
    };
    writeCache(all);
    return key;
}

const SCENARIO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function scenarioCacheKey(fingerprint) {
    return `scenario:${fingerprintHash(fingerprint)}`;
}

function getCachedScenario(fingerprint) {
    const key = scenarioCacheKey(fingerprint);
    const entry = readCache()[key];
    if (!entry?.scenarioId) return null;
    const age = Date.now() - new Date(entry.savedAt || 0).getTime();
    if (age > SCENARIO_CACHE_TTL_MS) return null;
    return entry;
}

function setCachedScenario(fingerprint, payload) {
    const key = scenarioCacheKey(fingerprint);
    const all = readCache();
    all[key] = {
        ...payload,
        savedAt: new Date().toISOString(),
        fingerprintHash: fingerprintHash(fingerprint),
    };
    writeCache(all);
    return key;
}

const SECTION_LAYOUT_VERSION = 7;

function buildFileLayoutFingerprint(buffer, fileName) {
    if (!buffer?.length) {
        return { fileName: String(fileName || ''), size: 0 };
    }
    return {
        fileName: String(fileName || ''),
        size: buffer.length,
        contentHash: crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 24),
    };
}

function sectionLayoutCacheKey(brokerSubtype, sectionId, fileFingerprint) {
    const fileFp = fileFingerprint ? fingerprintHash(fileFingerprint) : 'any';
    return `sectionLayout:${brokerSubtype || 'unknown'}:${sectionId}:${fileFp}`;
}

function getCachedSectionLayout(brokerSubtype, sectionId, fileFingerprint) {
    const key = sectionLayoutCacheKey(brokerSubtype, sectionId, fileFingerprint);
    const entry = readCache()[key];
    if (!entry?.headers?.length || !entry?.columnCenters?.length) return null;
    if ((entry.layoutVersion || 1) !== SECTION_LAYOUT_VERSION) return null;
    // Hot-cache без TTL — долгая память в pdf_parse_scenarios (БД)
    return entry;
}

function setCachedSectionLayout(brokerSubtype, sectionId, fileFingerprint, payload) {
    const key = sectionLayoutCacheKey(brokerSubtype, sectionId, fileFingerprint);
    const all = readCache();
    all[key] = {
        headers: payload.headers,
        columnCenters: payload.columnCenters,
        dataStart: payload.dataStart ?? null,
        headerRowCount: payload.headerRowCount ?? null,
        xTol: payload.xTol ?? null,
        layoutVersion: SECTION_LAYOUT_VERSION,
        savedAt: new Date().toISOString(),
    };
    writeCache(all);
    return key;
}

module.exports = {
    fingerprintHash,
    getCachedRule,
    setCachedRule,
    getCachedScenario,
    setCachedScenario,
    getCachedSectionLayout,
    setCachedSectionLayout,
    buildFileLayoutFingerprint,
    sectionLayoutCacheKey,
    SECTION_LAYOUT_VERSION,
    SCENARIO_CACHE_TTL_MS,
    CACHE_PATH,
};
