const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isTableCommand } = require('./martin_chat_intent');
const {
    formatHistoryBlock,
    formatTablesBlock,
    formatActiveTableBlock,
    buildUiContextFallback,
    mergeContextPacks,
    truncateText,
} = require('./martin_context_pack');

describe('martin_chat_intent', () => {
    it('isTableCommand: фильтр и extract', () => {
        assert.equal(isTableCommand('оставь только где debit_account = 62.01'), true);
        assert.equal(isTableCommand('вытащи инвентарный номер из колонки ОС'), true);
        assert.equal(
            isTableCommand(
                'Убери все строчки где в Колонке Контрагент, в колонке Договор Пусто.'
            ),
            true
        );
    });

    it('isTableCommand: expand_ks и delete_column', () => {
        assert.equal(isTableCommand('разбери аналитику'), true);
        assert.equal(isTableCommand('раскрой аналитику Дт и Кт'), true);
        assert.equal(isTableCommand('удали колонку Группа'), true);
        assert.equal(isTableCommand('убери из колонки ОС номер'), true);
        assert.equal(
            isTableCommand('удали из колонки ОС все инвентарные номера'),
            true
        );
    });

    it('isTableCommand: move/rename/add/undo', () => {
        assert.equal(isTableCommand('перенеси колонку Контрагент после Период'), true);
        assert.equal(isTableCommand('переименуй колонку Группа в Категория'), true);
        assert.equal(isTableCommand('добавь колонку Комментарий'), true);
        assert.equal(isTableCommand('скопируй колонку ОС как ОС копия'), true);
        assert.equal(isTableCommand('отмени последнее'), true);
    });

    it('isTableCommand: вопросы не команды', () => {
        assert.equal(isTableCommand('а что в целом это такое?'), false);
        assert.equal(isTableCommand('привет, как дела?'), false);
        assert.equal(isTableCommand('сколько тут строк?'), false);
    });
});

describe('martin_context_pack', () => {
    it('truncateText обрезает длинные сообщения', () => {
        const long = 'а'.repeat(500);
        assert.equal(truncateText(long, 400).length, 400);
        assert.ok(truncateText(long, 400).endsWith('…'));
    });

    it('formatTablesBlock помечает активную вкладку', () => {
        const block = formatTablesBlock(
            [
                {
                    snapshotId: 1,
                    label: 'Исходная КС',
                    scenarioId: 'ks_card_composite',
                    rowCount: 120,
                    sourceFileName: '76.xlsx',
                    sheetName: 'Исходная КС',
                },
            ],
            1
        );
        assert.match(block, /активная/i);
        assert.match(block, /120 строк/);
    });

    it('formatActiveTableBlock: headers и sample', () => {
        const block = formatActiveTableBlock({
            label: 'Обработанная КС',
            scenarioId: 'ks_card_flat',
            rowCount: 5,
            headers: ['period', 'rate', 'product_name'],
            sampleRows: [{ period: '01.10.2025', rate: '20%' }],
        });
        assert.match(block, /period \| rate/);
        assert.match(block, /20%/);
    });

    it('formatHistoryBlock: последние реплики', () => {
        const block = formatHistoryBlock([
            { role: 'user', content: 'привет' },
            { role: 'assistant', content: 'здравствуй' },
        ]);
        assert.match(block, /user: привет/);
        assert.match(block, /assistant: здравствуй/);
    });

    it('buildUiContextFallback и mergeContextPacks', () => {
        const ui = buildUiContextFallback({
            fileName: 'test.xlsx',
            headers: ['a', 'b'],
            rowCount: 10,
            sampleRow: { a: 1 },
        });
        assert.match(ui, /test\.xlsx/);
        const merged = mergeContextPacks('Проект #1', ui);
        assert.match(merged, /Проект #1/);
        assert.match(merged, /draft/);
    });
});
