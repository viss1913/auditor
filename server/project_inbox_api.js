const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { auditorSlugFromRequest, resolveAuditor } = require('./auditor_context');
const {
    SOURCE_KINDS,
    probeInbox,
    saveInboxUploads,
    saveInboxUploadsAuto,
    probeInboxProject,
    listInboxEntriesForParse,
    summarizeProjectInbox,
    buildInboxTree,
    clearProjectInbox,
    deleteInboxPath,
} = require('./project_inbox');
const { loadInboxDescriptors } = require('./inbox_disk');
const {
    DEFAULT_BROKER_PREFIX,
    isOpifScenario,
    detectBatchScenario,
} = require('./opif_martin');
const {
    assertProjectAccess,
    assertChatAccess,
    sendAccessError,
    HttpError,
} = require('./project_access');

const INBOX_UPLOAD_TMP = path.join(os.tmpdir(), 'auditor-inbox-upload');
const INBOX_UPLOAD_MAX_FILES = Math.min(
    500,
    Math.max(12, parseInt(process.env.INBOX_UPLOAD_MAX_FILES || '80', 10) || 80)
);

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => {
            fs.mkdirSync(INBOX_UPLOAD_TMP, { recursive: true });
            cb(null, INBOX_UPLOAD_TMP);
        },
        filename: (_req, file, cb) => {
            const safe = String(file.originalname || 'file').replace(/[^\w.\-()+ ]/g, '_');
            cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
        },
    }),
    limits: { fileSize: 120 * 1024 * 1024, files: INBOX_UPLOAD_MAX_FILES },
});

function inboxUploadHandler(handler) {
    return (req, res, next) => {
        upload.array('files', INBOX_UPLOAD_MAX_FILES)(req, res, (err) => {
            if (err) {
                console.error('[inbox-upload] multer:', err.message);
                return res.status(400).json({
                    error:
                        err.code === 'LIMIT_FILE_SIZE'
                            ? 'Файл слишком большой (лимит 120 MB на файл)'
                            : err.code === 'LIMIT_FILE_COUNT'
                              ? `Слишком много файлов в одной пачке (макс. ${INBOX_UPLOAD_MAX_FILES})`
                              : err.message,
                });
            }
            handler(req, res, next).catch((e) => {
                const sampleMeta = (() => {
                    try {
                        return JSON.parse(req.body?.filesMeta || '[]').slice(0, 3);
                    } catch {
                        return [];
                    }
                })();
                const sampleNames = (req.files || [])
                    .slice(0, 3)
                    .map((f) => f.originalname)
                    .join(' | ');
                console.error(
                    '[inbox-upload] handler:',
                    e.message,
                    'meta=',
                    JSON.stringify(sampleMeta),
                    'originalnames=',
                    sampleNames
                );
                if (!res.headersSent) res.status(500).json({ error: e.message });
            });
        });
    };
}

function registerInboxRoutes(router, { pool, snapshotStore, maybeLinkSnapshotToChat, logChatExchange, runBatchStartFromUploads }) {
    router.get('/projects/:projectId/inbox/tree', async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            await assertProjectAccess(pool, req, projectId);
            const auditor = await resolveAuditor(pool, 'martin');
            if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });
            const tree = buildInboxTree({ auditorSlug: auditor.slug, projectId, userId: req.user?.id }, projectId);
            res.json({ ok: true, tree, auditor: { slug: auditor.slug, name: auditor.name } });
        } catch (err) {
            if (err instanceof HttpError) return sendAccessError(res, err);
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/projects/:projectId/inbox', async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            await assertProjectAccess(pool, req, projectId);
            const auditor = await resolveAuditor(pool, 'martin');
            if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });
            const sources = summarizeProjectInbox({ auditorSlug: auditor.slug, projectId, userId: req.user?.id }, projectId);
            res.json({
                ok: true,
                auditor: { slug: auditor.slug, name: auditor.name },
                projectId,
                sources,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/projects/:projectId/inbox', async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });
            const result = clearProjectInbox(auditor.slug, projectId);
            res.json({
                ok: true,
                ...result,
                message: `Очистила хранилище проекта (${result.deletedFiles} файл(ов))`,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/projects/:projectId/inbox/item', async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            const relPath = String(req.query.path || '').trim();
            if (!relPath) return res.status(400).json({ error: 'Нужен query path' });
            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });
            const result = deleteInboxPath(auditor.slug, projectId, relPath);
            res.json({
                ok: true,
                ...result,
                message: `Удалила «${result.path}» (${result.deleted} файл(ов))`,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/projects/:projectId/inbox/probe', express.json(), async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });
            const userMessage = String(req.body.userMessage || '').trim();
            const probe = probeInboxProject(auditor.slug, projectId, userMessage);
            res.json({ ok: true, probe });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.get('/projects/:projectId/inbox/:kind/probe', async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            const kind = req.params.kind;
            if (!SOURCE_KINDS.includes(kind)) {
                return res.status(400).json({ error: 'Неизвестный тип источника' });
            }
            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            const prefix = req.query.prefix || (kind === 'broker' ? DEFAULT_BROKER_PREFIX : null);
            const probe = probeInbox(auditor.slug, projectId, kind, { prefix });
            res.json({ ok: true, probe });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post(
        '/projects/:projectId/inbox/upload',
        (req, res, next) => {
            console.log(
                `[inbox-upload] incoming project=${req.params.projectId} bytes=${req.headers['content-length'] || '?'}`
            );
            next();
        },
        inboxUploadHandler(async (req, res) => {
            const started = Date.now();
            const projectId = parseInt(req.params.projectId, 10);
            const files = req.files || [];
            if (!files.length) return res.status(400).json({ error: 'Нужен хотя бы один файл' });

            let filesMeta = [];
            try {
                filesMeta = JSON.parse(req.body.filesMeta || '[]');
            } catch {
                filesMeta = [];
            }

            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });

            console.log(
                `[inbox-upload] project=${projectId} auditor=${auditor.slug} files=${files.length}`
            );

            const saved = saveInboxUploadsAuto(auditor.slug, projectId, files, filesMeta);
            const skipProbe = req.query.skipProbe === '1';
            const probe = skipProbe ? null : probeInboxProject(auditor.slug, projectId, '');

            console.log(
                `[inbox-upload] ok saved=${saved.saved} ms=${Date.now() - started} skipProbe=${skipProbe}`
            );

            res.json({
                ok: true,
                saved: saved.saved,
                byKind: saved.byKindSaved,
                paths: saved.paths.slice(0, 30),
                probe,
                message: `В хранилище: **${saved.saved}** файл(ов) → \`${auditor.slug}/project-${projectId}\``,
            });
        })
    );

    router.post(
        '/projects/:projectId/inbox/:kind/upload',
        upload.array('files', 500),
        async (req, res) => {
            try {
                const projectId = parseInt(req.params.projectId, 10);
                const kind = req.params.kind;
                if (!SOURCE_KINDS.includes(kind)) {
                    return res.status(400).json({ error: 'Неизвестный тип источника' });
                }
                const files = req.files || [];
                if (!files.length) return res.status(400).json({ error: 'Нужен хотя бы один файл' });

                let filesMeta = [];
                try {
                    filesMeta = JSON.parse(req.body.filesMeta || '[]');
                } catch {
                    filesMeta = [];
                }

                const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
                const { saveInboxUploads: saveKind } = require('./project_inbox');
                const saved = saveKind(auditor.slug, projectId, kind, files, filesMeta);
                const probe = probeInbox(auditor.slug, projectId, kind, {
                    prefix: kind === 'broker' ? DEFAULT_BROKER_PREFIX : null,
                });

                res.json({
                    ok: true,
                    saved: saved.saved,
                    paths: saved.paths.slice(0, 20),
                    probe,
                    message: `Сохранено ${saved.saved} файл(ов) в inbox/${auditor.slug}/project-${projectId}/${kind}`,
                });
            } catch (err) {
                res.status(500).json({ error: err.message });
            }
        }
    );

    router.post('/projects/:projectId/inbox/parse', express.json(), async (req, res) => {
        try {
            const projectId = parseInt(req.params.projectId, 10);
            const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
            if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });

            const userMessage = String(req.body.userMessage || '').trim();
            if (!userMessage) {
                return res.status(422).json({
                    error: 'Напиши задачу в чате перед парсом — там могут быть правила и сценарий.',
                });
            }
            const chatSessionId = req.body.chatSessionId
                ? parseInt(req.body.chatSessionId, 10)
                : null;

            const entries = listInboxEntriesForParse(auditor.slug, projectId, {
                userMessage,
                kind: req.body.kind || null,
                prefix: req.body.filePrefix || null,
                pathScope: req.body.pathScope || null,
            });

            if (!entries.length) {
                const scopePath = req.body.pathScope?.path;
                const hint = scopePath
                    ? ` Не нашла «${scopePath}» — проверь выбор в 📎 или загрузи файл слева.`
                    : ' Сначала загрузи папку или файлы.';
                return res.status(422).json({
                    error: `В хранилище проекта нет файлов.${hint}`,
                });
            }

            const fileMetas = entries.map((e) => ({ name: e.name, relativePath: e.relativePath }));
            const scenarioId =
                req.body.scenarioId ||
                detectBatchScenario(fileMetas, userMessage, null);

            const opifFromPath = isOpifScenario(scenarioId);
            const files = loadInboxDescriptors(entries, { withBuffer: !opifFromPath });

            const body = {
                ...req.body,
                projectId,
                project_id: projectId,
                chatSessionId,
                userMessage,
                scenarioId: scenarioId || req.body.scenarioId || null,
                fromInbox: true,
                brokerChunkIndex: 1,
                brokerChunkTotal: 1,
                brokerFilesTotal: entries.length,
            };

            await runBatchStartFromUploads({ files, targetFile: null, body, res });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/projects/:projectId/inbox/broker/parse', express.json(), async (req, res) => {
        req.body = {
            ...(req.body || {}),
            userMessage: req.body?.userMessage || 'брокер 1F018 из inbox',
            filePrefix: req.body?.filePrefix || DEFAULT_BROKER_PREFIX,
            kind: 'broker',
            scenarioId: 'opif_broker',
        };
        const projectId = parseInt(req.params.projectId, 10);
        const auditor = await resolveAuditor(pool, auditorSlugFromRequest(req));
        if (!auditor) return res.status(404).json({ error: 'Аудитор не найден' });

        const entries = listInboxEntriesForParse(auditor.slug, projectId, {
            kind: 'broker',
            prefix: req.body.filePrefix,
            userMessage: req.body.userMessage,
        });
        if (!entries.length) {
            return res.status(422).json({ error: `В inbox нет broker-файлов с префиксом ${req.body.filePrefix}` });
        }

        const files = loadInboxDescriptors(entries, { withBuffer: false });
        await runBatchStartFromUploads({
            files,
            targetFile: null,
            body: {
                ...req.body,
                projectId,
                project_id: projectId,
                fromInbox: true,
                brokerChunkIndex: 1,
                brokerChunkTotal: 1,
                brokerFilesTotal: entries.length,
            },
            res,
        });
    });

    function chatScopeFromReq(req) {
        const chatSessionId = parseInt(req.params.chatId, 10);
        if (!Number.isFinite(chatSessionId)) throw new Error('Некорректный chatId');
        return { chatSessionId, userId: req.user?.id ?? null };
    }

    async function runChatInboxParse(req, res) {
        const scope = chatScopeFromReq(req);
        const chat = await pool.query(`SELECT id, project_id FROM chat_sessions WHERE id = $1`, [
            scope.chatSessionId,
        ]);
        if (!chat.rows.length) return res.status(404).json({ error: 'Чат не найден' });
        const projectId = chat.rows[0].project_id;

        const userMessage = String(req.body.userMessage || '').trim();
        if (!userMessage) {
            return res.status(422).json({
                error: 'Напиши задачу в чате перед парсом — там могут быть правила и сценарий.',
            });
        }
        const entries = listInboxEntriesForParse(scope, null, {
            userMessage,
            kind: req.body.kind || null,
            prefix: req.body.filePrefix || null,
            pathScope: req.body.pathScope || null,
        });

        if (!entries.length) {
            const scopePath = req.body.pathScope?.path;
            const hint = scopePath
                ? ` Не нашла «${scopePath}» — проверь выбор в 📎 или загрузи файл слева.`
                : ' Сначала загрузи папку или файлы.';
            return res.status(422).json({
                error: `В хранилище чата нет файлов.${hint}`,
            });
        }

        const fileMetas = entries.map((e) => ({ name: e.name, relativePath: e.relativePath }));
        const scenarioId =
            req.body.scenarioId || detectBatchScenario(fileMetas, userMessage, null);
        const opifFromPath = isOpifScenario(scenarioId);
        const files = loadInboxDescriptors(entries, { withBuffer: !opifFromPath });

        await runBatchStartFromUploads({
            files,
            targetFile: null,
            body: {
                ...req.body,
                projectId,
                project_id: projectId,
                chatSessionId: scope.chatSessionId,
                userMessage,
                scenarioId: scenarioId || req.body.scenarioId || null,
                fromInbox: true,
                brokerChunkIndex: 1,
                brokerChunkTotal: 1,
                brokerFilesTotal: entries.length,
            },
            res,
        });
    }

    router.get('/chats/:chatId/inbox/tree', async (req, res) => {
        try {
            const scope = chatScopeFromReq(req);
            const tree = buildInboxTree(scope);
            res.json({ ok: true, tree, chatSessionId: scope.chatSessionId });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/chats/:chatId/inbox', async (req, res) => {
        try {
            const scope = chatScopeFromReq(req);
            const result = clearProjectInbox(scope);
            res.json({
                ok: true,
                ...result,
                message: `Очистила хранилище чата (${result.deletedFiles} файл(ов))`,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/chats/:chatId/inbox/item', async (req, res) => {
        try {
            const scope = chatScopeFromReq(req);
            const relPath = String(req.query.path || '').trim();
            if (!relPath) return res.status(400).json({ error: 'Нужен query path' });
            const result = deleteInboxPath(scope, null, relPath);
            res.json({
                ok: true,
                ...result,
                message: `Удалила «${result.path}» (${result.deleted} файл(ов))`,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/chats/:chatId/inbox/probe', express.json(), async (req, res) => {
        try {
            const scope = chatScopeFromReq(req);
            const userMessage = String(req.body.userMessage || '').trim();
            const probe = probeInboxProject(scope, null, userMessage);
            res.json({ ok: true, probe });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post(
        '/chats/:chatId/inbox/upload',
        inboxUploadHandler(async (req, res) => {
            const started = Date.now();
            const scope = chatScopeFromReq(req);
            const files = req.files || [];
            if (!files.length) return res.status(400).json({ error: 'Нужен хотя бы один файл' });

            let filesMeta = [];
            try {
                filesMeta = JSON.parse(req.body.filesMeta || '[]');
            } catch {
                filesMeta = [];
            }

            const saved = saveInboxUploadsAuto(scope, null, files, filesMeta);
            const skipProbe = req.query.skipProbe === '1';
            const probe = skipProbe ? null : probeInboxProject(scope, null, '');

            console.log(
                `[inbox-upload] chat=${scope.chatSessionId} ok saved=${saved.saved} ms=${Date.now() - started}`
            );

            res.json({
                ok: true,
                saved: saved.saved,
                byKind: saved.byKindSaved,
                paths: saved.paths.slice(0, 30),
                probe,
                message: `В хранилище чата: **${saved.saved}** файл(ов)`,
            });
        })
    );

    router.post('/chats/:chatId/inbox/parse', express.json(), async (req, res) => {
        try {
            await runChatInboxParse(req, res);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { registerInboxRoutes };
