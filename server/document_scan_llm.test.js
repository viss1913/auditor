const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    isLikelyScanPdf,
    isMachineReadablePdf,
    isDocumentScanEnabled,
    parseRequestedTableColumns,
} = require('./document_scan_llm');

describe('document_scan_llm', () => {
    it('isLikelyScanPdf: мало текста → скан', () => {
        assert.equal(
            isLikelyScanPdf({ lineCount: 2, pageCount: 3, kind: 'unknown' }),
            true
        );
        assert.equal(
            isLikelyScanPdf({ lineCount: 50, pageCount: 2, kind: 'upd_ediweb' }),
            false
        );
    });

    it('isMachineReadablePdf: УПД с текстом — не скан', () => {
        assert.equal(
            isMachineReadablePdf({ lineCount: 50, pageCount: 2, kind: 'upd_ediweb' }),
            true
        );
        assert.equal(
            isLikelyScanPdf({ lineCount: 50, pageCount: 2, kind: 'upd_ediweb' }),
            false
        );
    });

    it('parseRequestedTableColumns: многострочный список колонок', () => {
        const cols = parseRequestedTableColumns(
            'надо создать таблицу:\nНазвание ООО\nИНН\nместо нахождения офиса\nУстанвный капитал'
        );
        assert.deepEqual(cols, [
            'Название ООО',
            'ИНН',
            'место нахождения офиса',
            'Устанвный капитал',
        ]);
    });

    it('parseRequestedTableColumns: надо создать таблицу в одну строку', () => {
        const cols = parseRequestedTableColumns(
            'надо создать таблицу: Название ООО, ИНН, место нахождения офиса, Уставный капитал'
        );
        assert.deepEqual(cols, [
            'Название ООО',
            'ИНН',
            'место нахождения офиса',
            'Уставный капитал',
        ]);
    });

    it('buildScanTableFromExtraction: only_user_cols', () => {
        const { buildScanTableFromExtraction } = require('./document_scan_llm');
        const { headers, rows } = buildScanTableFromExtraction(
            {
                headers: ['ООО', 'дата собрания', 'номер протокола', 'лишнее'],
                rows: [
                    {
                        ООО: 'Ромашка',
                        'дата собрания': '01.01.2024',
                        'номер протокола': '5',
                        лишнее: 'убрать',
                    },
                ],
                fullText: 'текст',
            },
            'создай таблицу: ООО, дата собрания, номер протокола'
        );
        assert.deepEqual(headers, ['ООО', 'дата собрания', 'номер протокола']);
        assert.deepEqual(rows, [
            {
                ООО: 'Ромашка',
                'дата собрания': '01.01.2024',
                'номер протокола': '5',
            },
        ]);
    });

    it('isDocumentScanEnabled по умолчанию включён', () => {
        const prev = process.env.DOCUMENT_SCAN_ENABLED;
        delete process.env.DOCUMENT_SCAN_ENABLED;
        assert.equal(isDocumentScanEnabled(), true);
        process.env.DOCUMENT_SCAN_ENABLED = prev;
    });
});
