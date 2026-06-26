const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseResultTableCommand } = require('./result_table_commands');
const { mergeResultTableCommand } = require('./result_table_resolve');
const { parseSplitToTableIntent, applyFilterToRows } = require('./table_row_filter');
const { createParseSnapshotStore } = require('./parse_snapshot_store');

const DEPO_HEADERS = [
    'period',
    'operationType',
    'name',
    'regNum',
    'isin',
    'amount',
    'quantity',
    'currency',
    'debit_account',
    'credit_account',
];

describe('split_to_table intent', () => {
    it('parseSplitToTableIntent: новая таблица + данные по ВТБ', () => {
        const cmd = parseSplitToTableIntent(
            'сделай новую таблицу и туда перенеси из этой все данные по ВТБ',
            DEPO_HEADERS
        );
        assert.equal(cmd.action, 'split_to_table');
        assert.equal(cmd.filters.length, 1);
        assert.equal(cmd.filters[0].column, 'name');
        assert.equal(cmd.filters[0].op, 'contains');
        assert.equal(cmd.filters[0].value, 'ВТБ');
    });

    it('mergeResultTableCommand: LLM filter_rows + «новая таблица» → split_to_table', () => {
        const msg = 'сделай новую таблицу ВТБ и перенеси туда все данные по ВТБ';
        const plan = {
            action: 'filter_rows',
            mode: 'keep',
            filters: [{ column: 'name', op: 'contains', value: 'ВТБ' }],
        };
        const regexCmd = { action: 'filter_rows', mode: 'keep', filters: plan.filters };
        const cmd = mergeResultTableCommand({ message: msg, headers: DEPO_HEADERS, plan, regexCmd });
        assert.equal(cmd.action, 'split_to_table');
        assert.equal(cmd.tableLabel, 'ВТБ');
    });

    it('parseSplitToTableIntent: Инструмент содержит Lukoil Capital', () => {
        const headers = ['Период', 'Документ', 'Инструмент', 'Контрагент'];
        const cmd = parseSplitToTableIntent(
            'создай новую вкладку Lukoil — где Инструмент содержит Lukoil Capital и перенеси найденные данные',
            headers
        );
        assert.equal(cmd.action, 'split_to_table');
        assert.equal(cmd.filters[0].column, 'Инструмент');
        assert.equal(cmd.filters[0].value, 'Lukoil Capital');
        assert.equal(cmd.filters[0].op, 'contains');
    });

    it('parseResultTableCommand: Инструмент=Lukoil Capital', () => {
        const headers = ['Период', 'Инструмент'];
        const cmd = parseResultTableCommand(
            'сделай новую таблицу и перенеси туда все строчки с Инструмент=Lukoil Capital',
            headers
        );
        assert.equal(cmd.action, 'split_to_table');
        assert.equal(cmd.filters[0].column, 'Инструмент');
        assert.equal(cmd.filters[0].value, 'Lukoil Capital');
    });

    it('parseResultTableCommand выбирает split_to_table раньше filter_rows', () => {
        const cmd = parseResultTableCommand(
            'создай новую вкладку ВТБ — оставь только строки где name содержит ВТБ',
            DEPO_HEADERS
        );
        assert.equal(cmd.action, 'split_to_table');
        assert.ok(cmd.filters?.length);
    });

    it('фильтр по колонке Инструмент равно Lukoil + в новой таблице', () => {
        const headers = [
            'ПЕРИОД',
            'ДОКУМЕНТ',
            'КОНТРАГЕНТ',
            'ID СДЕЛКИ',
            'ИНСТРУМЕНТ',
            'АНАЛИТИКА ДТ',
            'АНАЛИТИКА КТ',
            'СЧЁТ ДТ',
            'СУММА ДТ',
            'СЧЁТ КТ',
            'СУММА КТ',
        ];
        const msg =
            'сделай фильтр по колонке Инструмент, значение  в ячейке должно быть равно Lukoil. результат сделай в новой таблице';
        const cmd = parseResultTableCommand(msg, headers);
        assert.equal(cmd.action, 'split_to_table');
        assert.equal(cmd.filters.length, 1);
        assert.equal(cmd.filters[0].column, 'ИНСТРУМЕНТ');
        assert.equal(cmd.filters[0].op, 'eq');
        assert.equal(cmd.filters[0].value, 'Lukoil');
    });

    it('applyFilterToRows: eq Lukoil матчит префикс в Инструмент', () => {
        const rows = [
            { ИНСТРУМЕНТ: 'Lukoil Capital DAC 31 (EXCH)' },
            { ИНСТРУМЕНТ: 'СФО АТОН' },
            { ИНСТРУМЕНТ: 'Lukoil Securities BV 30 (EXCH)' },
        ];
        const { rows: kept, kept: count } = applyFilterToRows(rows, {
            mode: 'keep',
            combine: 'and',
            filters: [{ column: 'ИНСТРУМЕНТ', op: 'eq', value: 'Lukoil' }],
        });
        assert.equal(count, 2);
        assert.equal(kept.length, 2);
    });

    it('applyFilterToRows отбирает строки по contains', () => {
        const rows = [
            { name: 'ПАО ВТБ', quantity: 1 },
            { name: 'ПАО Газпром', quantity: 2 },
            { name: 'Банк ВТБ (ПАО)', quantity: 3 },
        ];
        const { rows: kept, kept: count } = applyFilterToRows(rows, {
            mode: 'keep',
            combine: 'and',
            filters: [{ column: 'name', op: 'contains', value: 'ВТБ' }],
        });
        assert.equal(count, 2);
        assert.equal(kept.length, 2);
    });
});

describe('copyRowsToNewSnapshot', () => {
    it('копирует подмножество без изменения исходника', async () => {
        if (!process.env.DB_HOST) {
            console.log('skip DB test: no DB_HOST');
            return;
        }
        const { pool } = require('./db');
        const store = createParseSnapshotStore(pool);

        const sourceId = await store.createSnapshot({
            projectId: 1,
            sourceFileName: 'test.xlsx',
            sheetName: 'депо',
            headers: DEPO_HEADERS,
            status: 'parsing',
        });
        await store.importParsedRows(sourceId, DEPO_HEADERS, [
            { name: 'ПАО ВТБ', operationType: 'Списание ЦБ' },
            { name: 'ПАО Газпром', operationType: 'Зачисление ЦБ' },
            { name: 'Банк ВТБ', operationType: 'Списание ЦБ' },
        ]);

        const result = await store.copyRowsToNewSnapshot(sourceId, {
            label: 'ВТБ',
            plan: {
                mode: 'keep',
                combine: 'and',
                filters: [{ column: 'name', op: 'contains', value: 'ВТБ' }],
            },
        });

        assert.equal(result.rowCount, 2);
        assert.ok(result.newSnapshotId);

        const sourceAfter = await store.getSnapshot(sourceId);
        assert.equal(sourceAfter.rowCount, 3);

        const page = await store.fetchRowsPage(result.newSnapshotId, { page: 1, limit: 50 });
        assert.equal(page.total, 2);
        assert.ok(page.rows.every((r) => String(r.name).includes('ВТБ')));

        await store.deleteSnapshot(result.newSnapshotId);
        await store.deleteSnapshot(sourceId);
    });
});
