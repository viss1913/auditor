const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'));
process.env.AUDITOR_INBOX_ROOT = tmpRoot;

const {
    saveInboxUploadsAuto,
    buildInboxTree,
    collectAllInboxEntries,
    filterEntriesByPathScope,
    listInboxEntriesForParse,
    normalizeStoredRelativePath,
} = require('./project_inbox');

describe('project_inbox path preservation', () => {
    const slug = 'lyubov';
    const projectId = 99;

    before(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
        fs.mkdirSync(tmpRoot, { recursive: true });
    });

    after(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('normalizeStoredRelativePath keeps full folder names', () => {
        assert.equal(
            normalizeStoredRelativePath('Люба/broker/1F018_jan.xlsx'),
            'Люба/broker/1F018_jan.xlsx'
        );
        assert.equal(
            normalizeStoredRelativePath('DEPO/report.pdf'),
            'DEPO/report.pdf'
        );
        assert.equal(
            normalizeStoredRelativePath('Wealth managment/sheet.xlsx'),
            'Wealth managment/sheet.xlsx'
        );
    });

    it('normalizeStoredRelativePath strips leading slash and keeps file..pdf', () => {
        assert.equal(
            normalizeStoredRelativePath('/Протоколы/протокол.pdf'),
            'Протоколы/протокол.pdf'
        );
        assert.equal(normalizeStoredRelativePath('doc..pdf'), 'doc..pdf');
    });

    it('saveInboxUploadsAuto falls back to multer originalname when meta empty', () => {
        const saved = saveInboxUploadsAuto(
            slug,
            100,
            [{ originalname: 'Протоколы/протокол.pdf', buffer: Buffer.from('p') }],
            [{}]
        );
        assert.equal(saved.saved, 1);
        assert.ok(
            fs.existsSync(
                path.join(tmpRoot, slug, 'project-100', 'workspace', 'Протоколы', 'протокол.pdf')
            )
        );
    });

    it('saveInboxUploadsAuto stores exact tree under workspace', () => {
        const files = [
            { originalname: '1F018_jan.xlsx', buffer: Buffer.from('a') },
            { originalname: 'report.pdf', buffer: Buffer.from('b') },
            { originalname: 'uk.xlsx', buffer: Buffer.from('c') },
        ];
        const meta = [
            { name: '1F018_jan.xlsx', relativePath: 'broker/2024/1F018_jan.xlsx' },
            { name: 'report.pdf', relativePath: 'DEPO/report.pdf' },
            { name: 'uk.xlsx', relativePath: 'Wealth managment/uk.xlsx' },
        ];

        const saved = saveInboxUploadsAuto(slug, projectId, files, meta);
        assert.equal(saved.saved, 3);

        const ws = path.join(tmpRoot, slug, `project-${projectId}`, 'workspace');
        assert.ok(fs.existsSync(path.join(ws, 'broker', '2024', '1F018_jan.xlsx')));
        assert.ok(fs.existsSync(path.join(ws, 'DEPO', 'report.pdf')));
        assert.ok(fs.existsSync(path.join(ws, 'Wealth managment', 'uk.xlsx')));

        const tree = buildInboxTree(slug, projectId);
        const names = (tree.tree.children || []).map((c) => c.name).sort();
        assert.deepEqual(names, ['DEPO', 'Wealth managment', 'broker']);

        const entries = collectAllInboxEntries(slug, projectId);
        assert.equal(entries.length, 3);
        assert.ok(entries.some((e) => e.relativePath === 'broker/2024/1F018_jan.xlsx'));
    });

    it('filterEntriesByPathScope limits parse to folder', () => {
        const entries = collectAllInboxEntries(slug, projectId);
        const brokerOnly = filterEntriesByPathScope(entries, { path: 'broker', type: 'folder' });
        assert.equal(brokerOnly.length, 1);
        assert.equal(brokerOnly[0].relativePath, 'broker/2024/1F018_jan.xlsx');
    });

    it('pathScope bypasses opif_broker broker-only filter', () => {
        const kart = { originalname: 'карт 58.1_HP.xlsx', buffer: Buffer.from('k') };
        saveInboxUploadsAuto(slug, projectId, [kart], [
            { name: 'карт 58.1_HP.xlsx', relativePath: 'карт 58.1_HP.xlsx' },
        ]);

        const auto = listInboxEntriesForParse(slug, projectId, { userMessage: '' });
        assert.ok(!auto.some((e) => e.name === 'карт 58.1_HP.xlsx'));

        const scoped = listInboxEntriesForParse(slug, projectId, {
            pathScope: { path: 'карт 58.1_HP.xlsx', type: 'file' },
        });
        assert.equal(scoped.length, 1);
        assert.equal(scoped[0].relativePath, 'карт 58.1_HP.xlsx');
    });

    it('chat scope: pathScope works when projectId arg is null (inbox/parse API shape)', () => {
        const chatId = 501;
        const chatScope = { chatSessionId: chatId, userId: 2 };
        saveInboxUploadsAuto(chatScope, null, [
            { originalname: '1F018_a.xlsx', buffer: Buffer.from('b') },
            { originalname: 'карт 58.1_HP.xlsx', buffer: Buffer.from('k') },
        ], [
            { name: '1F018_a.xlsx', relativePath: 'broker/1F018_a.xlsx' },
            { name: 'карт 58.1_HP.xlsx', relativePath: 'карт 58.1_HP.xlsx' },
        ]);

        const auto = listInboxEntriesForParse(chatScope, null, { userMessage: 'брокер 1F018' });
        assert.equal(auto.length, 1);
        assert.equal(auto[0].name, '1F018_a.xlsx');

        const scoped = listInboxEntriesForParse(chatScope, null, {
            pathScope: { path: 'карт 58.1_HP.xlsx', type: 'file' },
        });
        assert.equal(scoped.length, 1);
        assert.equal(scoped[0].relativePath, 'карт 58.1_HP.xlsx');
    });
});
