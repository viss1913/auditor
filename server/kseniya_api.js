const express = require('express');
const multer = require('multer');
const { parse1cTsvExport } = require('./parse_1c_tsv');
const { fixUploadNamesMiddleware } = require('./fix_upload_filename');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/kseniya/parse-text', upload.single('file'), fixUploadNamesMiddleware, (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Нужен file (.txt / .csv)' });

    const ext = (file.originalname || '').toLowerCase();
    if (!/\.(txt|csv|tsv)$/.test(ext)) {
        return res.status(400).json({ error: 'Поддерживаются .txt, .csv, .tsv' });
    }

    try {
        const parsed = parse1cTsvExport(file.buffer, { fileName: file.originalname });
        if (!parsed.ok) {
            return res.status(422).json({ error: parsed.errors.join('; '), ...parsed });
        }

        const limit = Math.min(parseInt(req.body.previewLimit || '200', 10) || 200, 500);
        res.json({
            ok: true,
            profile: parsed.profile,
            fileName: parsed.fileName,
            headers: parsed.headers,
            rows: parsed.rows.slice(0, limit),
            rowCount: parsed.rowCount,
            warnings: parsed.warnings,
            meta: parsed.meta,
            previewTruncated: parsed.rowCount > limit,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
