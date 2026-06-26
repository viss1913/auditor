const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    parseResultTableCommand,
    extractFillValueFromTemplate,
    removeTransferredFromSource,
} = require('./result_table_commands');

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

    it('delete_column: document без учёта регистра', () => {
        const h = ['period', 'document', 'operation_type', 'name'];
        const cmd = parseResultTableCommand('удали колонку document', h);
        assert.equal(cmd.action, 'delete_column');
        assert.equal(cmd.sourceColumn, 'document');
    });

    it('clean_source: убери из колонки ОС номер и дату', () => {
        const cmd = parseResultTableCommand('убери из колонки ОС номер и дату', headers);
        assert.equal(cmd.action, 'clean_source');
        assert.equal(cmd.sourceColumn, 'ОС');
        assert.equal(cmd.stripFromSource, true);
        assert.equal(cmd.extractFields.length, 2);
    });

    it('clean_source: удали из колонки ОС все инвентарные номера', () => {
        const cmd = parseResultTableCommand(
            'удали из колонки ОС все инвентарные номера',
            headers
        );
        assert.equal(cmd.action, 'clean_source');
        assert.equal(cmd.sourceColumn, 'ОС');
        assert.equal(cmd.extractFields.length, 1);
        assert.equal(cmd.extractFields[0].field, 'inventory');
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

    it('expand_ks_analytics', () => {
        const cmd = parseResultTableCommand('разбери аналитику', headers);
        assert.equal(cmd.action, 'expand_ks_analytics');
    });

    it('move_column', () => {
        const h = ['Период', 'Контрагент', 'Сумма'];
        const cmd = parseResultTableCommand('перенеси колонку Контрагент после Период', h);
        assert.equal(cmd.action, 'move_column');
        assert.equal(cmd.sourceColumn, 'Контрагент');
        assert.equal(cmd.afterColumn, 'Период');
    });

    it('rename_column', () => {
        const cmd = parseResultTableCommand('переименуй колонку Группа в Категория', headers);
        assert.equal(cmd.action, 'rename_column');
        assert.equal(cmd.sourceColumn, 'Группа');
        assert.equal(cmd.newColumnName, 'Категория');
    });

    it('add_column', () => {
        const cmd = parseResultTableCommand('добавь колонку Комментарий', headers);
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Комментарий');
    });

    it('add_column: новый столбец (синоним)', () => {
        const cmd = parseResultTableCommand(
            'а можешь сделать новый столбец Date of Payment',
            headers
        );
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Date of Payment');
    });

    it('add_column: shorthand add', () => {
        const cmd = parseResultTableCommand('add Date of Payment', headers);
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Date of Payment');
    });

    it('add_column: надо создать после document, назови Тип сделки', () => {
        const h = ['period', 'document', 'operation_type', 'name', 'regnum'];
        const cmd = parseResultTableCommand(
            'надо создать новую колонку после document, назови новую колонку Тип сделки',
            h
        );
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Тип сделки');
        assert.equal(cmd.afterColumn, 'document');
        assert.equal(cmd.position, 'after');
        assert.equal(cmd.fillFromColumn, undefined);
        assert.equal(cmd.containsRules, undefined);
    });

    it('delete_column: typo колггонку', () => {
        const h = [...headers, 'debit_account'];
        const cmd = parseResultTableCommand('удали плиз колггонку debit_account', h);
        assert.equal(cmd.action, 'delete_column');
        assert.equal(cmd.sourceColumn, 'debit_account');
    });

    it('delete_column: shorthand remove', () => {
        const h = [...headers, 'debit_account'];
        const cmd = parseResultTableCommand('remove debit_account', h);
        assert.equal(cmd.action, 'delete_column');
        assert.equal(cmd.sourceColumn, 'debit_account');
    });

    it('add_column: создай + заполни из аналитики по шаблону', () => {
        const ksHeaders = [
            'Период',
            'Документ',
            'Аналитика Дт',
            'Аналитика Кт',
            'Счёт Дт',
            'Сумма Кт',
        ];
        const cmd = parseResultTableCommand(
            "Создай колонку 'Подразделение' и заполни из 'Аналитика Кт' по шаблону: Подразделение [номер]",
            ksHeaders
        );
        assert.equal(cmd.action, 'add_column');
        assert.equal(cmd.newColumnName, 'Подразделение');
        assert.equal(cmd.fillFromColumn, 'Аналитика Кт');
        assert.ok(cmd.fillTemplate.includes('Подразделение'));
    });

    it('extractFillValueFromTemplate: подразделение из многострочной аналитики', () => {
        const val = extractFillValueFromTemplate(
            'Подразделение 1\nУслуги доработки металла 20%\nНаименование металла',
            'Подразделение [номер]',
            'Подразделение'
        );
        assert.equal(val, 'Подразделение 1');
    });

    it('extractFillValueFromTemplate: подразделение из одной строки', () => {
        const val = extractFillValueFromTemplate(
            'Подразделение 2 Услуги доработки металла 20% Наименование металла',
            'Подразделение [номер]',
            'Подразделение'
        );
        assert.equal(val, 'Подразделение 2');
    });

    it('fill_column: перенеси туда из Аналитика Кт и убери из ячеек', () => {
        const ksHeaders = [
            'Период',
            'Аналитика Кт',
            'Подразделение',
            'Сумма Кт',
        ];
        const history = [
            {
                role: 'user',
                content: "Создай колонку 'Подразделение' и заполни из 'Аналитика Кт'",
            },
        ];
        const cmd = parseResultTableCommand(
            'перенси туда из колонки Аналитика КТ соответствующее значение. Из Ячеек убери плиз значение',
            ksHeaders,
            history
        );
        assert.equal(cmd.action, 'fill_column');
        assert.equal(cmd.targetColumn, 'Подразделение');
        assert.equal(cmd.fillFromColumn, 'Аналитика Кт');
        assert.equal(cmd.stripFillFromSource, true);
    });

    it('strip_fill_source: только убрать из ячеек после переноса', () => {
        const ksHeaders = ['Период', 'Аналитика Кт', 'Подразделение'];
        const history = [
            {
                role: 'user',
                content: "Создай колонку 'Подразделение' и заполни из 'Аналитика Кт'",
            },
        ];
        const cmd = parseResultTableCommand('Из ячеек убери значение', ksHeaders, history);
        assert.equal(cmd.action, 'strip_fill_source');
        assert.equal(cmd.fillFromColumn, 'Аналитика Кт');
    });

    it('removeTransferredFromSource: убирает строку подразделения', () => {
        const src =
            'Подразделение 1\nУслуги доработки металла 20%\nНаименование металла';
        const cleaned = removeTransferredFromSource(
            src,
            'Подразделение 1',
            'Подразделение [номер]',
            'Подразделение'
        );
        assert.equal(cleaned, 'Услуги доработки металла 20%\nНаименование металла');
    });

    it('duplicate_column', () => {
        const cmd = parseResultTableCommand('скопируй колонку ОС как ОС копия', headers);
        assert.equal(cmd.action, 'duplicate_column');
        assert.equal(cmd.sourceColumn, 'ОС');
        assert.equal(cmd.newColumnName, 'ОС копия');
    });

    it('undo_last', () => {
        const cmd = parseResultTableCommand('отмени последнее', headers);
        assert.equal(cmd.action, 'undo_last');
    });

    it('replace_values: без слова «замени» — «списание Цб на продажа»', () => {
        const opifHeaders = ['period', 'operationType', 'name'];
        const cmd = parseResultTableCommand('а тепрь списание Цб на продажа', opifHeaders);
        assert.equal(cmd.action, 'replace_values');
        assert.equal(cmd.column, 'operationType');
        assert.ok(cmd.mappings.some((m) => m.from === 'Списание ЦБ' && m.to === 'продажа'));
    });

    it('extract: номер сделки mcxs из брокерской колонки', () => {
        const brokerHeaders = [
            '№ сделки, дата, время заключения сделки',
            'Описание операции',
            'Сумма, руб.',
        ];
        const cmd = parseResultTableCommand(
            'вынеси номер сделки из колонки сделки назови колонку Номер сделки',
            brokerHeaders
        );
        assert.equal(cmd.action, 'extract');
        assert.equal(cmd.sourceColumn, '№ сделки, дата, время заключения сделки');
        assert.ok(cmd.extractFields.some((f) => f.field === 'deal_number'));
        assert.ok(cmd.extractFields.some((f) => f.target_column === 'Номер сделки'));
    });

    it('extract: дата из описания операции', () => {
        const brokerHeaders = ['Описание операции', 'Сумма, руб.'];
        const cmd = parseResultTableCommand('вынеси дату из описания назови колонку Дата', brokerHeaders);
        assert.equal(cmd.action, 'extract');
        assert.equal(cmd.sourceColumn, 'Описание операции');
        assert.ok(cmd.extractFields.some((f) => f.field === 'date'));
    });
});
