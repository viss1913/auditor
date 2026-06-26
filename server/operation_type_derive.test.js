const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    deriveFromContainsRules,
    stripPhrasesFromText,
    parseContainsRulesFromMessage,
    resolveContainsRulesForCommand,
} = require('./operation_type_derive');
const { parseResultTableCommand } = require('./result_table_commands');

describe('operation_type_derive', () => {
    it('Поступление ц/б → Покупка + strip', () => {
        const src =
            'Сделка с ц/б НКР083939 от 30.12.2024 10:51:47 Поступление ц/б';
        const rules = parseContainsRulesFromMessage(
            'если есть Поступление ц/б то Покупка, убери Поступление'
        );
        assert.ok(rules.length >= 1);
        const { value, stripPhrases } = deriveFromContainsRules(src, rules);
        assert.equal(value, 'Покупка');
        const cleaned = stripPhrasesFromText(src, stripPhrases);
        assert.ok(!/поступление\s*ц/i.test(cleaned));
        assert.match(cleaned, /Сделка с ц\/б/);
    });

    it('parseResultTableCommand: колонка Тип сделки из operation_type', () => {
        const headers = ['period', 'operation_type', 'name'];
        const cmd = parseResultTableCommand(
            'Сделай новую колонку Тип сделки. Проанализируй operation_type: если есть Поступление ц/б — Покупка, убери Поступление ц/б',
            headers
        );
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Тип сделки');
        assert.equal(cmd.fillFromColumn, 'operation_type');
        assert.ok(cmd.containsRules?.length);
        assert.equal(cmd.stripFillFromSource, true);
    });

    it('CAPS без «добавь колонку»: ТИП СДЕЛКИ. ЕСЛИ ЕСТЬ…', () => {
        const headers = ['period', 'operation_type', 'name'];
        const msg =
            'ТИП СДЕЛКИ. ЕСЛИ ЕСТЬ «ПОСТУПЛЕНИЕ Ц/Б» ТО «ПОКУПКА», УБЕРИ ПОСТУПЛЕНИЕ Ц/Б';
        const cmd = parseResultTableCommand(msg, headers);
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Тип сделки');
        assert.equal(cmd.fillFromColumn, 'operation_type');
        assert.ok(cmd.containsRules?.some((r) => r.value === 'Покупка' || r.value === 'ПОКУПКА'));
        assert.equal(cmd.stripFillFromSource, true);
    });

    it('«из operation_type» не попадает в имя колонки', () => {
        const headers = ['period', 'operation_type', 'name'];
        const cmd = parseResultTableCommand('добавь колонку Тип сделки из operation_type', headers);
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Тип сделки');
        assert.equal(cmd.fillFromColumn, 'operation_type');
    });

    it('«Сделай колонку ТИП СДЕЛКИ…» заполняет из operation_type', () => {
        const headers = ['period', 'operation_type', 'name'];
        const cmd = parseResultTableCommand(
            'Сделай колонку ТИП СДЕЛКИ. ЕСЛИ ЕСТЬ «ПОСТУПЛЕНИЕ Ц/Б» ТО «ПОКУПКА», УБЕРИ ПОСТУПЛЕНИЕ Ц/Б',
            headers
        );
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Тип сделки');
        assert.equal(cmd.fillFromColumn, 'operation_type');
        assert.ok(cmd.containsRules?.length);
    });

    it('надо сделать + опечатки: Тип слделки, Проаналищзировать', () => {
        const headers = ['period', 'document', 'operation_type', 'name'];
        const msg =
            'надо сделать новую колонку Тип слделки. Проаналищзировать колонку operation_type  и если там есть Поступление ц/б то в новую колонку поместить Покупка';
        const cmd = parseResultTableCommand(msg, headers);
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Тип сделки');
        assert.equal(cmd.fillFromColumn, 'operation_type');
        assert.equal(cmd.afterColumn, 'document');
        assert.ok(cmd.containsRules?.some((r) => r.value === 'Покупка'));
    });

    it('колонка уже есть → fill_column из operation_type', () => {
        const headers = ['period', 'document', 'Тип сделки', 'operation_type', 'name'];
        const msg =
            'ТИП СДЕЛКИ. ЕСЛИ ЕСТЬ «ПОСТУПЛЕНИЕ Ц/Б» ТО «ПОКУПКА», УБЕРИ ПОСТУПЛЕНИЕ Ц/Б';
        const cmd = parseResultTableCommand(msg, headers);
        assert.equal(cmd.action, 'fill_column');
        assert.equal(cmd.targetColumn, 'Тип сделки');
        assert.equal(cmd.fillFromColumn, 'operation_type');
        assert.ok(cmd.containsRules?.length);
    });

    it('operation_type_classified: проанализировать + поместить Покупка', () => {
        const headers = ['period', 'document', 'operation_type', 'operation_type_classified', 'name'];
        const msg =
            "Проанализировать колонку operation_type и если там есть 'Поступление ц/б' то в новую колонку operation_type_classified поместить 'Покупка'";
        const cmd = parseResultTableCommand(msg, headers);
        assert.equal(cmd.action, 'fill_column');
        assert.equal(cmd.targetColumn, 'operation_type_classified');
        assert.equal(cmd.fillFromColumn, 'operation_type');
        assert.ok(cmd.containsRules?.some((r) => r.value === 'Покупка'));
    });
});
