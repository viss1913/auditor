const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseResultTableCommand } = require('./result_table_commands');
const { buildReplaceMap } = require('./table_value_replace');
const { extractFilePrefixFromText } = require('./orchestrator/structure_resolve');
const { probeFileList } = require('./opif_martin');

const OPIF_HEADERS = [
    'period',
    'operationType',
    'name',
    'regNum',
    'isin',
    'quantity',
    'amount',
    'currency',
    'registrationDate',
    'fee',
    'debit_account',
    'credit_account',
    'source_file',
    'source_path',
];

describe('replace_values', () => {
    it('распознаёт замену operationType из чата депо', () => {
        const cmd = parseResultTableCommand(
            'operationType замени в ячейках. если Списание ЦБ то замени на продажа Если попкука ЦБ то замени на покупка',
            OPIF_HEADERS
        );
        assert.equal(cmd.action, 'replace_values');
        assert.equal(cmd.column, 'operationType');
        assert.ok(cmd.mappings.some((m) => m.from === 'Списание ЦБ' && m.to === 'продажа'));
        assert.ok(cmd.mappings.some((m) => m.from === 'Зачисление ЦБ' && m.to === 'покупка'));
    });

    it('buildReplaceMap подменяет точные значения', () => {
        const map = buildReplaceMap([{ from: 'Списание ЦБ', to: 'продажа' }]);
        assert.equal(map.get('Списание ЦБ'), 'продажа');
    });
});

describe('broker prefix from message', () => {
    it('«начинаются с 1F018_» → filePrefix', () => {
        assert.equal(
            extractFilePrefixFromText('возьми плиз только файлы которые начинаются с 1F018_'),
            '1F018_'
        );
    });

    it('probe считает prefixMatches без учёта регистра', () => {
        const probe = probeFileList(
            [
                { name: '1F018_jan.xlsx' },
                { name: '1f018_feb.xlsx' },
                { name: 'other.xlsx' },
            ],
            'только файлы которые начинаются с 1f018_'
        );
        assert.equal(probe.prefix, '1f018_');
        assert.equal(probe.prefixMatches, 2);
        assert.equal(probe.suggestedScenario, 'opif_broker');
    });
});

describe('broker section from message', () => {
    const { extractBrokerSectionFromText } = require('./orchestrator/structure_resolve');

    it('«1.2 не исполнены» → brokerSection 1.2', () => {
        assert.equal(
            extractBrokerSectionFromText('нужны только 1.2 сделки обязательства из которых не исполнены'),
            '1.2'
        );
    });

    it('«1.1 прекращены» → brokerSection 1.1', () => {
        assert.equal(
            extractBrokerSectionFromText('возьми раздел 1.1 сделки обязательства прекращены'),
            '1.1'
        );
    });

    it('«спарси 1F018 прекращённые» → 1.1', () => {
        assert.equal(
            extractBrokerSectionFromText(
                'Спарси данные 1F018_ таблицы с 1.1. Сделки, обязательства из которых прекращены'
            ),
            '1.1'
        );
    });
});
