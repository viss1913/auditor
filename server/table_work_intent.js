/**
 * Естественный язык → «это команда к таблице», не болтовня в converse.
 * Regex + LLM-планировщик (result_table_llm) обрабатывают детали.
 */

const { parseResultTableCommand } = require('./result_table_commands');
const { isAggregateIntent } = require('./table_query_llm');
const { looksLikeReconcileIntent } = require('./reconcile_intent');

const COLUMN_WORD = /(?:колонк[а-яёю]*|столб[а-яёю]*|column)/i;

function looksLikeTableMutationIntent(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (looksLikeReconcileIntent(t)) return false;
    if (isAggregateIntent(t)) return false;

    const regexCmd = parseResultTableCommand(t, []);
    if (regexCmd?.action) return true;

    if (
        /(?:надо|нужно|хочу|можешь|можно|давай)\s+/i.test(t) &&
        /(?:колонк|столбц|таблиц|фильтр|строк|вкладк)/i.test(t)
    ) {
        return true;
    }
    if (/нов(?:ую|ый|ое)\s+(?:колонк|столбц)/i.test(t)) return true;
    if (/назов[а-яё]*\s+.*(?:колонк|столбц)/i.test(t)) return true;
    if (/(?:после|перед|after|before)\s+/i.test(t) && COLUMN_WORD.test(t)) return true;
    if (/тип\s+сделк/i.test(t)) return true;
    if (/переименуй|перенес[а-яё]*\s+(?:колонк|столбц)|дублируй\s+(?:колонк|столбц)/i.test(t)) {
        return true;
    }
    if (/оставь\s+(?:только|строк)|убер\w*\s+(?:все\s+)?(?:строч|строк)/i.test(t)) return true;
    if (/замен\w*|подмен/i.test(t) && COLUMN_WORD.test(t)) return true;

    return false;
}

module.exports = { looksLikeTableMutationIntent };
