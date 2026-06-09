/**
 * Реестр «парсеров-кураторов» — кто за что отвечает и что вызывать на бэке.
 * Единый источник для UI и будущего роутера агентов/скриптов.
 */
export const PARSER_PROFILES = [
  {
    id: 'anton',
    name: 'Антон',
    title: 'Парсинг 1С (ОС)',
    status: 'ready',
    description:
      'Разбор выгрузок 1С по основным средствам: сценарии, Martin, таблица в Postgres, extract/classify в режиме результата.',
    engines: ['parse_engine v2', 'scenarios/registry', 'parse_snapshots'],
    api: ['/api/parse/auto-start', '/api/parse/snapshots/:id/rows', '/api/parse/snapshots/:id/apply-operation'],
    cursorAgent: 'anton',
    uiRoute: 'anton',
    sources: ['excel_1c_os'],
  },
  {
    id: 'lyubov',
    name: 'Любовь',
    title: 'Аудит ОПИФ: УК · Брокер · ДЕПО',
    status: 'ready',
    description:
      'Классический контур сверки: загрузка выгрузок УК, брокера и депозитария в trades, просмотр и запуск аудита трёх сторон.',
    engines: ['parse_uk', 'parseBroker', 'parseDEPO', 'audit'],
    api: ['/upload', '/trades', '/audit', '/audit/preview'],
    cursorAgent: 'lyubov',
    uiRoute: 'lyubov',
    sources: ['uk', 'broker', 'depo'],
  },
  {
    id: 'pavel',
    name: 'Павел',
    title: 'Нетиповые Excel / договоры',
    status: 'planned',
    description:
      'Отдельные форматы и договорная документация. Сначала — свой парсер и правила, без смешивания с ОС и ОПИФ.',
    engines: ['tbd'],
    api: ['/api/ai/generate-rule-from-file'],
    cursorAgent: 'pavel',
    uiRoute: 'pavel',
    sources: ['excel_custom', 'contracts'],
  },
  {
    id: 'kseniya',
    name: 'Ксения',
    title: 'Эталон и сверка колонок',
    status: 'ready',
    description:
      'Текстовые выгрузки 1С (txt/csv): карточка 90, реестр сделок. Сверка с эталоном — в разработке.',
    engines: ['parse_1c_tsv', 'target_rule_infer', 'compare_target'],
    api: ['/api/kseniya/parse-text', '/api/parse/infer-from-target', '/api/parse/compare-target'],
    cursorAgent: 'kseniya',
    uiRoute: 'kseniya',
    sources: ['excel_1c_os', 'target_sample'],
  },
];

export function getParserProfile(id) {
  return PARSER_PROFILES.find((p) => p.id === id) || null;
}
