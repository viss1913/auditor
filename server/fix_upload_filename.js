/**
 * Multer передаёт originalname в latin1 — кириллица превращается в «Ð…».
 */

function fixMulterFilename(name) {
    if (!name || typeof name !== 'string') return name;
    try {
        const fixed = Buffer.from(name, 'latin1').toString('utf8');
        if (/[а-яА-ЯёЁ]/.test(fixed)) return fixed;
        if (/[ÐÑÃÂ]/.test(name) && /[а-яА-ЯёЁ]/.test(fixed)) return fixed;
        return name;
    } catch {
        return name;
    }
}

/** Починить уже сохранённые в БД строки (utf8 прочитанный как latin1). */
function fixMojibakeUtf8(str) {
    if (!str || typeof str !== 'string') return str;
    if (!/[ÐÑÃÂ][\u0080-\u00FF]/.test(str)) return str;
    try {
        const fixed = Buffer.from(str, 'latin1').toString('utf8');
        if (/[а-яА-ЯёЁ]/.test(fixed)) return fixed;
    } catch {
        /* ignore */
    }
    return str;
}

function normalizeUploadReq(req) {
    if (req.file?.originalname) {
        req.file.originalname = fixMulterFilename(req.file.originalname);
    }
    if (req.files) {
        for (const key of Object.keys(req.files)) {
            for (const f of req.files[key]) {
                if (f?.originalname) f.originalname = fixMulterFilename(f.originalname);
            }
        }
    }
}

function fixUploadNamesMiddleware(req, res, next) {
    normalizeUploadReq(req);
    next();
}

module.exports = {
    fixMulterFilename,
    fixMojibakeUtf8,
    normalizeUploadReq,
    fixUploadNamesMiddleware,
};
