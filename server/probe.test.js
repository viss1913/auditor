const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    probeFileList,
    detectBatchScenario,
    filterFilesForScenario,
    extractFilePrefix,
} = require('./opif_martin');

describe('opif probe', () => {
    it('probeFileList: pdf → opif_depo', () => {
        const probe = probeFileList([
            { name: 'depo1.pdf' },
            { name: 'depo2.pdf' },
        ]);
        assert.equal(probe.fileCount, 2);
        assert.equal(probe.byKind.pdf, 2);
        assert.equal(probe.suggestedScenario, 'opif_depo');
    });

    it('probeFileList: broker prefix match', () => {
        const probe = probeFileList([
            { name: '1F018_jan.xlsx' },
            { name: '1F018_feb.xlsx' },
            { name: 'other.xlsx' },
        ]);
        assert.equal(probe.prefixMatches, 2);
        assert.equal(probe.suggestedScenario, 'opif_broker');
    });

    it('detectBatchScenario из фразы «депо»', () => {
        const files = [{ originalname: 'mixed.xlsx' }];
        assert.equal(detectBatchScenario(files, 'это депо, парси', null), 'opif_depo');
    });

    it('extractFilePrefix из userMessage', () => {
        assert.equal(extractFilePrefix('префикс Fskdlh', null), 'fskdlh');
    });

    it('filterFilesForScenario: broker prefix', () => {
        const files = [
            { originalname: '1F018_a.xlsx' },
            { originalname: 'skip.xlsx' },
            { originalname: '1F018_b.pdf' },
        ];
        const filtered = filterFilesForScenario(files, 'opif_broker', '', null);
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].originalname, '1F018_a.xlsx');
    });
});
