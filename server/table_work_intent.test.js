const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeTableMutationIntent } = require('./table_work_intent');

describe('table_work_intent', () => {
    it('аудит не считается мутацией таблицы', () => {
        const msg =
            'Надо сделать Аудит. результат в новую таблицу, сверяем с брокером по name, period';
        assert.equal(looksLikeTableMutationIntent(msg), false);
    });

    it('надо создать колонку после document', () => {
        const msg = 'надо создать новую колонку после document, назови новую колонку Тип сделки';
        assert.equal(looksLikeTableMutationIntent(msg), true);
    });

    it('не путает с вопросом сколько строк', () => {
        assert.equal(looksLikeTableMutationIntent('сколько строк в таблице'), false);
    });

    it('тип сделки derive', () => {
        assert.equal(
            looksLikeTableMutationIntent(
                'ТИП СДЕЛКИ. ЕСЛИ ЕСТЬ «ПОСТУПЛЕНИЕ Ц/Б» ТО «ПОКУПКА», УБЕРИ ПОСТУПЛЕНИЕ Ц/Б'
            ),
            true
        );
    });
});
