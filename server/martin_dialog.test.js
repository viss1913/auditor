const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const { buildSessionPlan, applyAnswer } = require('./orchestrator/session_plan');
const { resolveAnswerRegex } = require('./orchestrator/answer_resolve');
const { analyzeLayout } = require('./analyze_layout');
const { parseOpifBatch } = require('./opif_martin');
const { writeBrokerWorkbook } = require('./fixtures/generators/node/gen_broker');
const { isBrokerSection12Start } = require('./parse_broker');

const FIXTURES = path.join(__dirname, 'fixtures');
const origEnv = { ...process.env };

function makeBrokerBufferFromRows(rows) {
    const ws = xlsx.utils.aoa_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('martin smart dialog', () => {
    beforeEach(() => {
        process.env = { ...origEnv };
    });
    afterEach(() => {
        process.env = origEnv;
    });

    it('MARTIN_SMART_DIALOG=1: pick_scenario для FAS-файла', () => {
        const sample = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');
        if (!fs.existsSync(sample)) return;

        process.env.MARTIN_SMART_DIALOG = '1';
        const buf = fs.readFileSync(sample);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const plan = buildSessionPlan(layout, null, null, {
            userMessage: '',
            answers: {},
            autostart: true,
        });

        assert.equal(plan.needsUserInput, true);
        assert.ok(plan.pendingQuestions.some((q) => q.id === 'pick_scenario'));
    });

    it('applyAnswer pick_scenario → os_01_hierarchy ready', () => {
        const sample = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');
        if (!fs.existsSync(sample)) return;

        process.env.MARTIN_SMART_DIALOG = '1';
        const buf = fs.readFileSync(sample);
        const layout = analyzeLayout(buf, 'Исходная выгрузка 01');
        const plan = buildSessionPlan(layout, null, null, { answers: {}, autostart: true });
        const next = applyAnswer(plan, 'pick_scenario', 'os_01_hierarchy');
        assert.equal(next.sessionState.scenarioId, 'os_01_hierarchy');
    });

    it('resolveAnswerRegex: дерево «да разверни»', () => {
        const q = {
            id: 'pick_tree_flatten',
            options: [
                { value: 'confirm', label: 'Да, развернуть так' },
                { value: 'scenario:os_08_osv', label: 'Нет, это ОСВ 08' },
            ],
        };
        assert.equal(resolveAnswerRegex('да разверни как в примере', q), 'confirm');
        assert.equal(resolveAnswerRegex('нет это оборотка 08', q), 'scenario:os_08_osv');
    });

    it('resolveAnswerRegex: UK колонка I', () => {
        const q = {
            id: 'pick_uk_quantity_column',
            options: [
                { value: '7', label: 'Колонка H' },
                { value: '8', label: 'Колонка I — пример: 100' },
            ],
        };
        assert.equal(resolveAnswerRegex('колонка ай там штуки', q), '8');
    });
});

describe('broker batch fixtures', () => {
    it('broker_1f018_clean: 2 сделки из секции 1.2', async () => {
        const brokerPath = path.join(FIXTURES, 'tricky', 'broker', 'broker_1f018_clean.xlsx');
        if (!fs.existsSync(brokerPath)) {
            writeBrokerWorkbook(brokerPath, { includeSection: true });
        }
        const buf = fs.readFileSync(brokerPath);
        const files = [
            {
                originalname: '1F018_jan.xlsx',
                buffer: buf,
                webkitRelativePath: 'broker/2024/1F018_jan.xlsx',
            },
        ];
        const result = await parseOpifBatch(files, 'opif_broker', '', null);
        assert.ok(result.rows.length >= 2);
        assert.equal(result.rows[0].source_file, '1F018_jan.xlsx');
        assert.equal(result.rows[0].source_path, 'broker/2024/1F018_jan.xlsx');
    });

    it('broker alt header: isBrokerSection12Start', () => {
        assert.equal(
            isBrokerSection12Start('1.2 Сделки, ожидающие исполнения на отчётную дату'),
            true
        );
    });

    it('broker_1f018_alt_header: parse batch', async () => {
        const brokerPath = path.join(FIXTURES, 'tricky', 'broker', 'broker_1f018_alt_header.xlsx');
        if (!fs.existsSync(brokerPath)) {
            writeBrokerWorkbook(brokerPath, { includeSection: true, variant: 'alt' });
        }
        const buf = fs.readFileSync(brokerPath);
        const result = await parseOpifBatch(
            [{ originalname: '1F018_feb.xlsx', buffer: buf }],
            'opif_broker',
            '',
            null
        );
        assert.ok(result.rows.length >= 2);
    });
});
