/**
 * Роутинг сообщений Martin: команда к таблице vs запрос к данным vs диалог.
 */

const { isAggregateIntent } = require('./table_query_llm');

function isTableCommand(text) {
    const t = String(text || '').trim();
    if (!t) return false;

    const rowEmptyFilter =
        /(?:убер|удал)\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)\s+где/i.test(t) ||
        /(?:где|если)\s+.+(?:пуст\w*|пусто|не\s+заполн)/i.test(t);

    const stripFromColumn =
        /(?:убер\S*|удал\S*|очист\S*|вычист\S*)\s+(?:из|в)\s+колонк/i.test(t) &&
        !/(?:все\s+)?(?:строч\w*|строк\w*)\s+где/i.test(t);

    const tableCommandIntent =
        /(вытащи|извлек|перенес|убер|удал|очист)/i.test(t) &&
        /(колонк|инвентар|номер|дат|аналитик|ячеек)/i.test(t) &&
        !rowEmptyFilter &&
        !stripFromColumn;

    const filterLike =
        rowEmptyFilter ||
        /фильтр|оставь\s+(?:только|строк)|только\s+(?:строк|если|где|по)|(?:убер|удал)\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)|исключ\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)/i.test(
            t
        ) ||
        /(?:есть\s+значен|заполнен\w*|не\s+пуст\w*)/i.test(t) ||
        /(?:а|и)\s+ещ[её]|только\s+по\s+/i.test(t) ||
        /\bname\s*=/i.test(t) ||
        /debit[_\s]?account\s*=/i.test(t) ||
        /credit[_\s]?account\s*=/i.test(t);

    const splitLike =
        /(?:сделай|создай|добавь|открой)\s+(?:новую\s+)?(?:таблиц|вкладк|лист)/i.test(t) ||
        /нов(?:ую|ая|ый)\s+(?:таблиц|вкладк|лист)/i.test(t) ||
        /отдельн\w*\s+таблиц/i.test(t) ||
        /(?:скопируй|перенес\w*)\s+(?:в\s+)?нов/i.test(t) ||
        /(?:вынеси|вытащи)\s+(?:в\s+)?(?:отдельн|нов)/i.test(t);

    const replaceLike =
        /замен|подмен/i.test(t) ||
        (/\s+на\s+/i.test(t) && /(?:списан|зачисл|покупк|продаж)/i.test(t));

    const classifyLike =
        /(проанализ|классиф|определи|отправь\s+на\s+анализ|аренд|ремонт|движим|недвижим|имуществ)/i.test(t) &&
        !tableCommandIntent &&
        !filterLike &&
        !splitLike;

    const expandKsLike = /(разбери|раскрой|разверни)\s+аналитик/i.test(t);

    const deleteColumnLike =
        /(?:удал\S*|убер\S*|remove|delete)\s+(?:колонк[ауи]?\s+|column\s+)/i.test(t) &&
        !/(?:из|в)\s+колонк/i.test(t);

    const moveColumnLike =
        /перенес[а-яё]*\s+колонк[ауиеё]?/i.test(t) && /(?:после|перед|after|before)/i.test(t);

    const renameColumnLike = /переименуй\s+колонк[ауи]?/i.test(t);

    const addColumnLike = /добавь\s+колонк[ауи]?/i.test(t);

    const duplicateColumnLike =
        /(?:скопируй|дублируй)\s+колонк[ауи]?/i.test(t) && /(?:как|в)\s+/i.test(t);

    const undoLike = /отмени\s+последн/i.test(t);

    const columnHint = /^колонк[ауеи]\s+\S/i.test(t);

    return (
        tableCommandIntent ||
        stripFromColumn ||
        filterLike ||
        splitLike ||
        replaceLike ||
        classifyLike ||
        expandKsLike ||
        deleteColumnLike ||
        moveColumnLike ||
        renameColumnLike ||
        addColumnLike ||
        duplicateColumnLike ||
        undoLike ||
        columnHint
    );
}

function isTableQuery(text) {
    if (isTableCommand(text)) return false;
    return isAggregateIntent(text);
}

module.exports = { isTableCommand, isTableQuery };
