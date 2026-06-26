const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatAuditResult, buildAuditComment, decorateAuditRow } = require('./audit_report_labels');

describe('audit_report_labels', () => {
    it('formatAuditResult по-русски', () => {
        assert.equal(formatAuditResult('match'), 'Найдено');
        assert.equal(formatAuditResult('only_left'), 'Не найдено в брокере');
        assert.equal(formatAuditResult('value_mismatch'), 'Расхождение');
    });

    it('buildAuditComment для расхождения quantity', () => {
        const msg = buildAuditComment(
            'value_mismatch',
            ['quantity'],
            { quantity: 10, amount: 100 },
            { quantity: 9, amount: 100 },
            [{ left: 'quantity', right: 'quantity' }]
        );
        assert.match(msg, /количество: УК 10/);
        assert.match(msg, /брокер 9/);
    });

    it('buildAuditComment: regNum в комментарии как есть', () => {
        const msg = buildAuditComment(
            'value_mismatch',
            ['regNum'],
            { regNum: '10401000B' },
            { regNum: '1-04-01000-A' },
            [{ left: 'regNum', right: 'regNum' }]
        );
        assert.match(msg, /рег\.номер/);
    });

    it('decorateAuditRow', () => {
        const row = decorateAuditRow(
            {
                reconcile_status: 'only_left',
                period: '14.02.2025',
                name: 'ВТБ, ао',
            },
            { valuePairs: [] }
        );
        assert.equal(row.audit_result, 'Не найдено в брокере');
        assert.match(row.audit_comment, /ВТБ/);
    });
});
