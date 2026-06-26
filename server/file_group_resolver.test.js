const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildMergeStrategyQuestion,
    headersCompatible,
} = require('./universal_parse/file_group_resolver');

describe('file_group_resolver', () => {
    it('buildMergeStrategyQuestion содержит 3 варианта', () => {
        const q = buildMergeStrategyQuestion([
            {
                key: 'a',
                label: 'Excel · uk_card',
                kind: 'excel',
                fileCount: 2,
                sampleHeaders: ['Дата', 'БУ'],
                sampleNames: ['a.xlsx', 'b.xlsx'],
            },
            {
                key: 'b',
                label: 'PDF · depo',
                kind: 'pdf',
                fileCount: 1,
                sampleHeaders: ['Зачисление ЦБ'],
                sampleNames: ['depo.pdf'],
            },
        ]);
        assert.equal(q.id, 'pick_merge_strategy');
        assert.equal(q.options.length, 3);
        assert.match(q.promptTemplate, /2/);
    });

    it('headersCompatible — одинаковые заголовки', () => {
        const r = headersCompatible(['A', 'B', 'source_file'], ['A', 'B', 'source_file']);
        assert.equal(r.ok, true);
    });

    it('headersCompatible — разное число колонок', () => {
        const r = headersCompatible(['A', 'B'], ['A', 'B', 'C']);
        assert.equal(r.ok, false);
    });
});
