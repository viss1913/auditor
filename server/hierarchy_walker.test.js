const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { walkHierarchy, resolveHierarchyFields } = require('./hierarchy_walker');

const sampleXlsx = path.join(__dirname, '..', 'Пример для ТЗ ФАС- ОС.xlsx');

describe('hierarchy_walker', () => {
    it('path Здания → КЦ → ОП КЦ → лист', () => {
        const data = xlsx.utils.sheet_to_json(
            xlsx.readFile(sampleXlsx).Sheets['Исходная выгрузка 01'],
            { header: 1, defval: '' }
        );
        const { rows } = walkHierarchy(data, { data_start_row: 8, layout: { name_column: 0 } });
        const leaf = rows.find((r) => /Профсоюзная/.test(r.leaf_name) && !/Профсоюзная 2/.test(r.leaf_name));
        assert.ok(leaf, 'лист Профсоюзная');
        assert.deepEqual(leaf.path, ['Здания', 'КЦ', 'ОП КЦ']);
        assert.equal(resolveHierarchyFields('unit', leaf.path), 'КЦ');
        assert.equal(resolveHierarchyFields('subdivision', leaf.path), 'ОП КЦ');
    });

    it('path Здания → РТК Волгоград → ОП АБГ → 80-000722', () => {
        const data = xlsx.utils.sheet_to_json(
            xlsx.readFile(sampleXlsx).Sheets['Исходная выгрузка 01'],
            { header: 1, defval: '' }
        );
        const { rows } = walkHierarchy(data, { data_start_row: 8, layout: { name_column: 0 } });
        const leaf = rows.find((r) => /80-000722/.test(r.leaf_name));
        assert.ok(leaf, 'модульное здание 80-000722');
        assert.deepEqual(leaf.path, ['Здания', 'РТК Волгоград', 'ОП АБГ-Волгоград']);
        assert.equal(resolveHierarchyFields('group', leaf.path), 'Здания');
        assert.equal(resolveHierarchyFields('unit', leaf.path), 'РТК Волгоград');
        assert.equal(resolveHierarchyFields('parent_unit', leaf.path), 'РТК Волгоград');
        assert.equal(resolveHierarchyFields('subdivision', leaf.path), 'ОП АБГ-Волгоград');
    });
});
