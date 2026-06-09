const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { parseOpifBatch, OPIF_SNAPSHOT_HEADERS } = require('./opif_martin');

function brokerSectionHeader() {
    return '1.2. Сделки, не исполнены на отчетную дату';
}

function makeBrokerBuffer() {
    const rows = [
        [brokerSectionHeader()],
        [
            '15.01.2024',
            '',
            'Покупка',
            'ПАО Test ISIN RU0009029540',
            100,
            50000,
            'RUB',
            '20.01.2024',
            '21.01.2024',
            50,
        ],
        ['1.3. Прочее'],
    ];
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('batch-start / parseOpifBatch', () => {
    it('merged rows с source_file и source_path', async () => {
        const buf = makeBrokerBuffer();
        const files = [
            {
                originalname: '1F018_jan.xlsx',
                buffer: buf,
                webkitRelativePath: 'broker/2024/1F018_jan.xlsx',
            },
            { originalname: 'other.xlsx', buffer: buf },
        ];
        const result = await parseOpifBatch(files, 'opif_broker', '', null);
        assert.ok(result.rows.length >= 1);
        assert.equal(result.filesProcessed, 1);
        assert.equal(result.scenarioId, 'opif_broker');
        assert.ok(OPIF_SNAPSHOT_HEADERS.includes('source_file'));
        assert.equal(result.rows[0].source_file, '1F018_jan.xlsx');
        assert.equal(result.rows[0].source_path, 'broker/2024/1F018_jan.xlsx');
    });

    it('depo filter: только pdf проходят', () => {
        const { filterFilesForScenario } = require('./opif_martin');
        const files = [
            { originalname: 'depo.pdf', buffer: Buffer.from('x') },
            { originalname: 'note.txt', buffer: Buffer.from('x') },
        ];
        const filtered = filterFilesForScenario(files, 'opif_depo', '', null);
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].originalname, 'depo.pdf');
    });
});
