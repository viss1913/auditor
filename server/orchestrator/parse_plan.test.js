const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildParsePlan, applyParsePlanToOrchestratorAnswers } = require('./parse_plan');

const BROKER_FOLDER = [
    { name: '1F018_jan.xlsx', relativePath: 'broker/1F018_jan.xlsx' },
    { name: '1F018_feb.xlsx', relativePath: 'broker/1F018_feb.xlsx' },
    { name: '1F008_mar.xlsx', relativePath: 'broker/1F008_mar.xlsx' },
    { name: 'other.xlsx', relativePath: 'broker/other.xlsx' },
];

describe('parse_plan', () => {
    it('пустая команда + один Excel → parse_sheet', () => {
        const plan = buildParsePlan('', {
            fileMetas: [{ name: 'карт 76.07.6.xlsx' }],
        });
        assert.equal(plan.intent, 'parse_sheet');
        assert.equal(plan.scenarioId, null);
    });

    it('«брокер 1F008 и в одну таблицу» → opif_broker + prefix + merge', () => {
        const plan = buildParsePlan('возьми только файлы 1F008 и в одну таблицу', {
            fileMetas: BROKER_FOLDER,
        });
        assert.equal(plan.scenarioId, 'opif_broker');
        assert.equal(plan.filePrefix, '1F008_');
        assert.equal(plan.mergeMode, 'single_table');
        assert.equal(plan.fileFilter.mode, 'prefix');
        assert.match(plan.summary, /1F008/);
    });

    it('«депо» на папке PDF → opif_depo', () => {
        const plan = buildParsePlan('это депо, парси', {
            fileMetas: [{ name: 'depo1.pdf' }, { name: 'depo2.pdf' }],
        });
        assert.equal(plan.scenarioId, 'opif_depo');
        assert.equal(plan.intent, 'parse_batch');
        assert.equal(plan.mergeMode, 'single_table');
    });

    it('«разбери карточку 76» → parse_sheet без OPIF', () => {
        const plan = buildParsePlan('разбери карточку 76', {
            fileMetas: [{ name: 'карт 76.07.6.xlsx' }],
        });
        assert.equal(plan.intent, 'parse_sheet');
        assert.notEqual(plan.scenarioId, 'opif_broker');
    });

    it('applyParsePlanToOrchestratorAnswers мержит hints', () => {
        const plan = buildParsePlan('брокер 1F018', { fileMetas: BROKER_FOLDER });
        const answers = applyParsePlanToOrchestratorAnswers(plan, { sheetName: 'Лист1' });
        assert.equal(answers.scenarioId, 'opif_broker');
        assert.equal(answers.filePrefix, '1F018_');
        assert.equal(answers.sheetName, 'Лист1');
    });

    it('«все листы» → parseAllSheets', () => {
        const plan = buildParsePlan('разбери все листы', {
            fileMetas: [{ name: 'book.xlsx' }],
            parseAllSheets: false,
        });
        assert.equal(plan.parseAllSheets, true);
    });

    it('«1.2 не исполнены» → opif_broker + brokerSection 1.2', () => {
        const plan = buildParsePlan(
            'брокер 1F018, раздел 1.2 сделки обязательства из которых не исполнены',
            { fileMetas: BROKER_FOLDER }
        );
        assert.equal(plan.scenarioId, 'opif_broker');
        assert.equal(plan.brokerSection, '1.2');
        assert.match(plan.summary, /1\.2/);
    });

    it('«1.1 прекращены» → brokerSection 1.1', () => {
        const plan = buildParsePlan('брокер 1F018, только 1.1 сделки обязательства прекращены', {
            fileMetas: BROKER_FOLDER,
        });
        assert.equal(plan.brokerSection, '1.1');
        assert.match(plan.summary, /1\.1/);
    });

    it('человеческая фраза: спарси 1F018 прекращённые → 1.1', () => {
        const plan = buildParsePlan(
            'Спарси данные 1F018_ и внутри из файла таблицы с 1.1. Сделки, обязательства из которых прекращены',
            { fileMetas: BROKER_FOLDER }
        );
        assert.equal(plan.scenarioId, 'opif_broker');
        assert.equal(plan.filePrefix, '1F018_');
        assert.equal(plan.brokerSection, '1.1');
    });

    it('«неисполненные обязательства» без номера раздела → 1.2', () => {
        const plan = buildParsePlan('разбери брокера 1F018, где обязательства не исполнены', {
            fileMetas: BROKER_FOLDER,
        });
        assert.equal(plan.brokerSection, '1.2');
    });
});
