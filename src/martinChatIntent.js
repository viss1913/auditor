function normalizeIntentText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

const COLUMN_WORD = /(?:колонк[а-яёю]*|столб[а-яёю]*|column)/i;

function isAddColumnIntent(text) {
  const t = String(text || '').trim();
  if (/^add\s+\S/i.test(t)) return true;
  if (/(?:add|create)\s+(?:a\s+)?(?:new\s+)?column\b/i.test(t)) return true;
    if (
        /(?:добавь|создай|сделай|можешь\s+сделать|можно\s+(?:добавить|сделать|создать)|надо\s+созда(?:ть|й)|нужно\s+созда(?:ть|й)|надо\s+сделать|нужно\s+сделать)/i.test(
      t
    ) &&
    COLUMN_WORD.test(t)
  ) {
    return true;
  }
  if (/тип\s+сделк/i.test(t) && /если\s+есть/i.test(t)) return true;
  if (/нов(?:ую|ый|ое)\s+(?:колонк|столбц)/i.test(t) && /(?:после|перед|after|before|назов)/i.test(t)) {
    return true;
  }
  if (/(?:вытащи|извлеки|вынеси)/i.test(t) && /назов[а-яё]*\s+(?:колонк|столбц)/i.test(t) && !/(?:добавь|создай|сделай|надо|нужно)/i.test(t)) {
    return false;
  }
  if (/назов[а-яё]*\s+(?:новую\s+)?(?:колонк|столбц)/i.test(t)) return true;
  return /(?:создай|сделай|добавь)\s+колонк/i.test(t) && /заполни/i.test(t);
}

function isDeriveColumnIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/тип\s+сделк/i.test(t) && /если\s+есть|поступлен|списан|переоценк/i.test(t)) return true;
  if (/если\s+есть/i.test(t) && /(?:то|—|->|→)/i.test(t) && /убер|удал/i.test(t) && !COLUMN_WORD.test(t)) {
    return true;
  }
  return false;
}

function isDeleteColumnIntent(text) {
  const t = String(text || '').trim();
  if (isDeriveColumnIntent(t)) return false;
  if (/^remove\s+\S/i.test(t)) return true;
  if (/(?:из|в)\s+(?:колонк|столбц)/i.test(t)) return false;
  if (/(?:все\s+)?(?:строч|строк)\w*\s+где/i.test(t)) return false;
  if (!/(?:удали|удал|убери|убер|remove|delete)/i.test(t)) return false;
  if (COLUMN_WORD.test(t)) return true;
  return /\b(?:удали|удал|убери|убер|remove|delete)\s+(?:плиз\s+)?[a-z][a-z0-9_]*\b/i.test(t);
}

function isAggregateIntent(text) {
  const t = normalizeIntentText(text);
  if (isAddColumnIntent(text)) return false;
  if (/заполни/i.test(t) && COLUMN_WORD.test(t)) return false;
  if (/по\s+шаблону/i.test(t)) return false;
  if (/непуст|заполнен|пустых/.test(t) && /сколько|колич|count/.test(t)) return true;
  if (/сколько\s+строк|число\s+строк|сколько\s+всего/.test(t)) return true;
  if (/спроси\s+(?:все|всё|данн)/.test(t)) return true;
  if (/миним|max|максим|средн|сумм|итого|посчитай|посчит|total/.test(t)) return true;
  if (/(?:^|\s)по\s+/.test(t) && /сальдо|оборот|сумм|колонк|столбц/.test(t)) return true;
  return false;
}

export function looksLikeTableMutationIntent(text) {
  if (isTableCommand(text)) return true;
  const t = String(text || '').trim();
  if (!t || isTableQuery(text)) return false;
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
  return false;
}

export function isTableCommand(text) {
  const t = String(text || '').trim();
  if (!t) return false;

  const rowEmptyFilter =
    /(?:убер|удал)\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)\s+где/i.test(t) ||
    /(?:где|если)\s+.+(?:пуст\w*|пусто|не\s+заполн)/i.test(t);

  const stripFromColumn =
    /(?:убер\S*|удал\S*|очист\S*|вычист\S*)\s+(?:из|в)\s+(?:колонк|столбц)/i.test(t) &&
    !/(?:все\s+)?(?:строч\w*|строк\w*)\s+где/i.test(t);

  const tableCommandIntent =
    /(вытащи|извлек|перенес|убер|удал|очист|вынес)/i.test(t) &&
    /(колонк|столбц|инвентар|номер|дат|аналитик|ячеек|туда|сделк|mcxs)/i.test(t) &&
    !rowEmptyFilter &&
    !stripFromColumn;

  const fillTransferLike =
    /(?:перенес|перенси|заполни)/i.test(t) &&
    /(?:туда|из\s+(?:колонк|столбц)|в\s+(?:колонк|столбц))/i.test(t);

  const stripTransferredLike =
    /убер\w*/i.test(t) &&
    /(?:из\s+)?ячеек|значен|перенес|то\s+что/i.test(t);

  const filterLike =
    rowEmptyFilter ||
    /фильтр|оставь\s+(?:только|строк)|только\s+(?:строк|если|где|по)|(?:убер|удал)\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)|исключ\w*\s+(?:все\s+)?(?:строч\w*|строк\w*)/i.test(
      t
    ) ||
    /оставь\s+(?:только\s+)?(?:сделк|строк|где|если|с\s+)/i.test(t) ||
    /(?:есть\s+значен|заполнен\w*|не\s+пуст\w*)/i.test(t) ||
    /(?:а|и)\s+ещ[её]|только\s+по\s+/i.test(t) ||
    /\bname\s*=/i.test(t) ||
    /debit[_\s]?account\s*=/i.test(t) ||
    /credit[_\s]?account\s*=/i.test(t);

  const splitLike =
    (/^(?:сделай|создай|добавь|открой)\s+(?:новую\s+)?(?:таблиц|вкладк|лист)/i.test(t) ||
      /нов(?:ую|ая|ый)\s+(?:таблиц|вкладк|лист)/i.test(t) ||
      /отдельн\w*\s+таблиц/i.test(t) ||
      /(?:скопируй|перенес\w*)\s+(?:в\s+)?нов/i.test(t) ||
      /(?:вынеси|вытащи)\s+(?:в\s+)?(?:отдельн|нов)/i.test(t)) &&
    !/создай\s+таблиц[ауе]\s*:/i.test(t);

  const replaceLike =
    /замен|подмен/i.test(t) ||
    (/\s+на\s+/i.test(t) && /(?:списан|зачисл|покупк|продаж)/i.test(t));

  const classifyLike =
    /(проанализ|классиф|определи|отправь\s+на\s+анализ|аренд|ремонт|движим|недвижим|имуществ)/i.test(t) &&
    !tableCommandIntent &&
    !filterLike &&
    !splitLike;

  const expandKsLike = /(разбери|раскрой|разверни)\s+аналитик/i.test(t);

  const deleteColumnLike = isDeleteColumnIntent(t);

  const moveColumnLike =
    /перенес[а-яё]*\s+(?:колонк|столбц)[ауиеё]?/i.test(t) &&
    /(?:после|перед|after|before)/i.test(t);

  const renameColumnLike = /переименуй\s+(?:колонк|столбц)[ауи]?/i.test(t);

  const addColumnLike = isAddColumnIntent(t);

  const duplicateColumnLike =
    /(?:скопируй|дублируй)\s+(?:колонк|столбц)[ауи]?/i.test(t) && /(?:как|в)\s+/i.test(t);

  const undoLike = /отмени\s+последн/i.test(t);

  const columnHint = /^(?:колонк|столбц)[ауеи]\s+\S/i.test(t);

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
    fillTransferLike ||
    stripTransferredLike ||
    duplicateColumnLike ||
    undoLike ||
    columnHint
  );
}

export function isTableQuery(text) {
  if (isTableCommand(text)) return false;
  return isAggregateIntent(text);
}

/** «да» после вопроса Martin про удаление колонки → реальная команда, не болтовня LLM */
export function resolvePendingTableConfirmation(text, history = []) {
  const t = String(text || '').trim();
  if (!/^(да|yes|ок|ok|подтверждаю|конечно|удаляй|убирай|давай|делай|верно|ага|угу)$/i.test(t)) {
    return null;
  }

  const lastAssist = [...history].reverse().find((m) => m.role === 'assistant');
  if (!lastAssist?.content) return null;
  const c = String(lastAssist.content);

  const patterns = [
    /(?:^|\s)remove\s+["'`]?([^"'`\n]+?)["'`]?/i,
    /drop\s+column\s+["'`]?([^"'`\n]+?)["'`]?/i,
    /удал(?:ить|яю|и|ение)?\s+(?:колонк\w*|столбц\w*)\s+["«'"`]?([^"»'"`\n]+?)["»'"`]?/i,
    /убираю\s+(?:колонк\w*|столбц\w*)\s+["«'"`]?([^"»'"`\n]+?)["»'"`]?/i,
    /(?:колонк|столбц)[ауи]\s+["«'"`]?([^"»'"`\n]+?)["»'"`]?/i,
  ];
  for (const re of patterns) {
    const m = c.match(re);
    if (m?.[1]) {
      const column = m[1].replace(/[.?!…]+$/g, '').trim();
      if (column && !/^(ты|вы|подтвержд)/i.test(column)) {
        return { kind: 'delete_column', message: `удали колонку ${column}` };
      }
    }
  }
  return null;
}

/** Команда универсальной сверки (Martin reconcile). */
export function looksLikeReconcileIntent(text) {
  const t = normalizeIntentText(text);
  if (!t) return false;
  if (/(?:сверь|сверк\w*|сверя\w*|сопостав\w*|сравн\w*)/.test(t)) return true;
  if (/(?:^|[\s,.:;!?])аудит(?:[\s,.:;!?]|$)/.test(t) || /(?:^|[\s,.:;!?])audit(?:[\s,.:;!?]|$)/.test(t)) {
    return true;
  }
  if (/\breconcile\b/.test(t)) return true;
  if (/\bcompare\b/.test(t) && /\bwith\b/.test(t)) return true;
  if (/сверя\w*\s+с\s+/.test(t)) return true;
  if (/сопостав\w*\s+с\s+/.test(t)) return true;
  return false;
}
