const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    isEgrulIntent,
    extractInnsFromText,
    resolveRequestedFields,
    findInnColumn,
} = require('./egrul_intent');
const { resolveP7Status, extractFormationMethod } = require('./egrul_parse');

describe('egrul_intent', () => {
    it('detects egrul intent', () => {
        assert.equal(isEgrulIntent('проверь контрагентов по ЕГРЮЛ'), true);
        assert.equal(isEgrulIntent('разбери осв'), false);
    });

    it('extracts inns', () => {
        assert.deepEqual(extractInnsFromText('ИНН 7707083893 и 5024088380'), ['7707083893', '5024088380']);
    });

    it('finds inn column', () => {
        assert.equal(findInnColumn(['Контрагент', 'ИНН', 'Сумма']), 'ИНН');
    });

    it('resolves p7-only fields', () => {
        const fields = resolveRequestedFields('только п.7 недостоверность');
        assert.ok(fields.includes('p7Status'));
        assert.ok(fields.includes('additionalInfo'));
    });
});

describe('egrul_parse p7', () => {
    it('marks unreliable text', () => {
        const text =
            'Дополнительные сведения сведения недостоверны (результаты проверки достоверности содержащихся в ЕГРЮЛ сведений о юридическом лице)';
        const p7 = resolveP7Status(text);
        assert.equal(p7.code, 'unreliable');
        assert.equal(p7.needsAlert, true);
    });

    it('marks formation ok', () => {
        const text = 'Сведения о регистрации 8Способ образованияСоздание юридического лица до 01.07.2002';
        const p7 = resolveP7Status(text);
        assert.equal(p7.code, 'formation_ok');
        assert.equal(extractFormationMethod(text), 'Создание юридического лица до 01.07.2002');
    });
});

describe('egrul_storage', () => {
    it('saves pdf under batch dir', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'egrul-store-'));
        const prev = process.env.AUDITOR_EGRUL_ROOT;
        process.env.AUDITOR_EGRUL_ROOT = tmpRoot;
        delete require.cache[require.resolve('./egrul_storage')];
        const { createEgrulBatchDir, saveEgrulPdf } = require('./egrul_storage');

        const batch = createEgrulBatchDir();
        const saved = saveEgrulPdf(Buffer.from('%PDF-test'), {
            inn: '7707083893',
            ogrn: '1027700132195',
            batchDir: batch.absDir,
        });

        assert.ok(fs.existsSync(saved.absPath));
        assert.match(saved.fileName, /^EGRUL_7707083893_/);
        assert.ok(saved.relativePath.endsWith('.pdf'));

        if (prev == null) delete process.env.AUDITOR_EGRUL_ROOT;
        else process.env.AUDITOR_EGRUL_ROOT = prev;
        delete require.cache[require.resolve('./egrul_storage')];
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
});
