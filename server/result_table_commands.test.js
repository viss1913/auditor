const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseResultTableCommand } = require('./result_table_commands');

describe('parseResultTableCommand', () => {
    const headers = ['Группа', 'ОС', 'остаточная на конец'];

    it('classify: колонка + правило аудитора', () => {
        const cmd = parseResultTableCommand(
            'Проанализируй колонку ОС: если аренда — rent, ремонт — repair, участок — real_estate. Иначе not_sure',
            headers
        );
        assert.equal(cmd.action, 'classify');
        assert.equal(cmd.sourceColumn, 'ОС');
        assert.ok(cmd.auditorRule.includes('аренда'));
    });

    it('extract: дата и адрес', () => {
        const cmd = parseResultTableCommand('Вытащи дату и адрес из колонки ОС', headers);
        assert.equal(cmd.action, 'extract');
        assert.equal(cmd.sourceColumn, 'ОС');
    });

    it('extract: инвентарный номер не уходит в classify', () => {
        const cmd = parseResultTableCommand(
            'Перенеси в отдельные колонки инвентарный номер и дату из колонки ОС',
            headers
        );
        assert.equal(cmd.action, 'extract');
        assert.equal(cmd.sourceColumn, 'ОС');
    });

    it('delete_column', () => {
        const cmd = parseResultTableCommand('удали колонку Группа', headers);
        assert.equal(cmd.action, 'delete_column');
        assert.equal(cmd.sourceColumn, 'Группа');
    });

    it('clean_source: убери из колонки ОС номер и дату', () => {
        const cmd = parseResultTableCommand('убери из колонки ОС номер и дату', headers);
        assert.equal(cmd.action, 'clean_source');
        assert.equal(cmd.sourceColumn, 'ОС');
        assert.equal(cmd.stripFromSource, true);
    });

    it('не путает убери из колонки с удали колонку', () => {
        const cmd = parseResultTableCommand('убери из колонки ОС номер', headers);
        assert.notEqual(cmd.action, 'delete_column');
    });

    it('replace_values: operationType списание/зачисление', () => {
        const opifHeaders = ['period', 'operationType', 'name'];
        const cmd = parseResultTableCommand(
            'operationType замени: если Списание ЦБ то продажа, если Зачисление ЦБ то покупка',
            opifHeaders
        );
        assert.equal(cmd.action, 'replace_values');
        assert.equal(cmd.column, 'operationType');
        assert.ok(cmd.mappings.length >= 2);
    });
});
