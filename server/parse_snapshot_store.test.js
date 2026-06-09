const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { PARSE_SNAPSHOT_DDL } = require('./parse_snapshot_schema');
const { createParseSnapshotStore } = require('./parse_snapshot_store');

const hasDb = Boolean(process.env.DB_HOST || process.env.CI);

describe('parse_snapshot_store', { skip: !hasDb }, () => {
    let pool;
    let store;

    before(async () => {
        pool = new Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432', 10),
            database: process.env.DB_NAME || 'auditor',
            user: process.env.DB_USER || 'postgres',
            password: String(process.env.DB_PASSWORD || '1qazXSW@'),
        });
        await pool.query(PARSE_SNAPSHOT_DDL);
        store = createParseSnapshotStore(pool);
    });

    after(async () => {
        if (pool) await pool.end();
    });

    it('importParsedRows + fetchRowsPage + updateRowsBatch', async () => {
        const id = await store.createSnapshot({
            headers: ['ОС', 'Сумма'],
            sourceFileName: 'test.xlsx',
        });
        const rows = [
            { ОС: 'Вагон 000001, 01.01.2020', Сумма: '100' },
            { ОС: 'Здание 80-560482, 31.12.2021', Сумма: '200' },
        ];
        const count = await store.importParsedRows(id, ['ОС', 'Сумма'], rows);
        assert.equal(count, 2);

        const page = await store.fetchRowsPage(id, { page: 1, limit: 10 });
        assert.equal(page.total, 2);
        assert.equal(page.rows.length, 2);
        assert.equal(page.rows[0].ОС, rows[0].ОС);

        await store.updateRowsBatch(id, [
            { rowIndex: 0, patch: { inventory_extracted: '000001' } },
        ]);
        const page2 = await store.fetchRowsPage(id, { page: 1, limit: 1 });
        assert.equal(page2.rows[0].inventory_extracted, '000001');

        await store.deleteSnapshot(id);
        const gone = await store.getSnapshot(id);
        assert.equal(gone, null);
    });

    it('filterRows удаляет строки по JSONB-условию', async () => {
        const id = await store.createSnapshot({
            headers: ['debit_account', 'credit_account', 'amount'],
            sourceFileName: 'uk.xlsx',
        });
        const rows = [
            { debit_account: '58.01.4', credit_account: '76.07.2', amount: '10' },
            { debit_account: '58.01.4', credit_account: '91.01.10', amount: '61' },
            { debit_account: '58.01.4', credit_account: '76.07.2', amount: '5' },
        ];
        await store.importParsedRows(id, ['debit_account', 'credit_account', 'amount'], rows);

        const filtered = await store.filterRows(id, {
            mode: 'keep',
            combine: 'and',
            filters: [
                { column: 'debit_account', op: 'eq', value: '58.01.4' },
                { column: 'credit_account', op: 'eq', value: '76.07.2' },
            ],
        });

        assert.equal(filtered.before, 3);
        assert.equal(filtered.after, 2);
        assert.equal(filtered.removed, 1);

        const page = await store.fetchRowsPage(id, { page: 1, limit: 10 });
        assert.equal(page.total, 2);
        assert.ok(page.rows.every((r) => r.credit_account.startsWith('76.07.2')));

        const snap = await store.getSnapshot(id);
        assert.equal(snap.rowCount, 2);

        await store.deleteSnapshot(id);
    });
});
