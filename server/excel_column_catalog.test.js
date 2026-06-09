const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { buildColumnCatalog, matchUserTextToMeasures } = require('./excel_column_catalog');

const sampleXlsx = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');

describe('excel_column_catalog', () => {
    it('строит каталог для ведомости 01', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const { catalog } = buildColumnCatalog(buf, 'Исходная выгрузка 01');
        assert.equal(catalog.layout_type, 'hierarchy_rows');
        assert.equal(catalog.name_column.index, 0);
        assert.ok(catalog.metrics.length >= 8);
        const residualClose = catalog.metrics.find((m) => m.suggested_measure === 'residual_close');
        assert.ok(residualClose, 'должна быть residual_close');
        assert.ok(residualClose.index === 10, `residual_close index ${residualClose.index}`);
        assert.ok(catalog.sample_leaf_rows.length >= 3);
        assert.ok(catalog.hierarchy_tree_sample.length >= 3);
        const modular = catalog.hierarchy_tree_sample.find((r) => /80-000722/.test(r.leaf_name));
        assert.ok(modular);
        assert.deepEqual(modular.path, ['Здания', 'РТК Волгоград', 'ОП АБГ-Волгоград']);
    });

    it('матчит фразу про остаточную на конец', () => {
        const buf = fs.readFileSync(sampleXlsx);
        const { catalog } = buildColumnCatalog(buf, 'Исходная выгрузка 01');
        const match = matchUserTextToMeasures('остаточная стоимость на конец периода', catalog);
        assert.ok(match.measures.some((m) => m.suggested_measure === 'residual_close'));
    });
});
