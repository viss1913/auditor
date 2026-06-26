# Чеклист тестирования tricky-фикстур парсера

Реестр фикстур: [`server/fixtures/manifest.json`](../server/fixtures/manifest.json)

Генерация всех Excel:

```powershell
cd server
npm run fixtures:generate
```

Автотесты:

```powershell
cd server
npm run test:fixtures
```

Дополнительно (умный диалог + tools + Gemini client):

```powershell
cd server
node --test martin_dialog.test.js martin_tools.test.js llm_client.test.js
```

---

## Умный диалог (`MARTIN_SMART_DIALOG=1`)

В `.env` сервера:

```env
MARTIN_SMART_DIALOG=1
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash
```

| Шаг | Действие | Ожидание |
|-----|----------|----------|
| 1 | Прикрепить `fas_os_sample.xlsx` или `os01_hierarchy_clean.xlsx` | Martin **спрашивает** flat vs hierarchy или про дерево |
| 2 | Ответить «с иерархией» или «да, разверни» | Черновик таблицы, `previewIsTentative: true` |
| 3 | Подтвердить ещё раз при необходимости | Полный парс в БД, колонки Группа/ОС |
| 4 | UK: `uk_qty_col_i.xlsx` + «колонка ай» | quantity из col I |
| 5 | Непонятный ответ → Gemini через `/api/ai/resolve-answer` | Система понимает вариант из списка |

---

## Брокер OPIF (`1F018_*`)

Фикстуры: `tricky/broker/broker_1f018_clean.xlsx`, `broker_1f018_alt_header.xlsx`

| Шаг | Действие | Ожидание |
|-----|----------|----------|
| 1 | Прикрепить папку/файлы `1F018_*` | Сценарий `opif_broker` |
| 2 | Написать «возьми брокера, файлы 1F018_» | Только excel с префиксом |
| 3 | Сверить таблицу | ≥2 сделки, `source_file` / `source_path` заполнены |
| 4 | `broker_no_section.xlsx` | Warning: секция 1.2 не найдена |

---

## Подготовка

1. PostgreSQL запущен, `.env` настроен
2. `node server/migrate_db.js`
3. Терминал 1: `cd server && node index.js`
4. Терминал 2: `npm run dev` (из корня)
5. Открыть http://localhost:5173 → AI Martin

---

## P0 — критичные (прогнать в первую очередь)

| ID | Файл | chatHint | Проверить |
|----|------|----------|-----------|
| os01_hierarchy_clean | `tricky/os_01/os01_hierarchy_clean.xlsx` | «разверни с деревом» | Сценарий os_01_hierarchy, колонки Группа/ОС, ≥3 строк |
| os01_flat_only | `tricky/os_01/os01_flat_only.xlsx` | «плоская таблица» | Сценарий os_01_flat, колонка «тип», без Группа/Узел |
| os01_merged_title | `tricky/os_01/os01_merged_title.xlsx` | «да, разверни» | Парс несмотря на merged A1:H3 |
| os01_hidden_rows | `tricky/os_01/os01_hidden_rows.xlsx` | «старт» | Строки без hidden-дублей |
| os01_gray_subtotals | `tricky/os_01/os01_gray_subtotals.xlsx` | «старт» | «Итого по группе» не в результате |
| os08_osv_clean | `tricky/os_08/os08_osv_clean.xlsx` | «старт» | os_08_osv, колонка Объект, 80-000662 |
| os76_card_clean | `tricky/os_76/os76_card_clean.xlsx` | «старт» | os_76, ≥5 договоров, «Договор 1» |
| uk_qty_col_i | `tricky/uk/uk_qty_col_i.xlsx` | «старт» | uk_card, quantity из col I |
| uk_osv_58_01_4 | `tricky/uk/uk_osv_58_01_4.xlsx` | «старт» | uk_osv_58, дерево БУ/Кол., ≥80 строк, ВТБ в Наименовании |
| wide_metrics_years | `tricky/wide/wide_metrics_years.xlsx` | «старт» | wide_metrics, годы в колонках |

### Шаги для каждой фикстуры

1. Прикрепить файл скрепкой в чат Martin
2. Написать chatHint (или «старт»)
3. Если Martin спрашивает про дерево — ответить текстом («да, разверни» / «плоская»)
4. Сверить topbar: сценарий
5. Сверить таблицу: row count, колонки, 1–2 эталонные строки

---

## P1 — дизамбiguация и multi-sheet

| ID | Файл | chatHint | Проверить |
|----|------|----------|-----------|
| os76_vs_08_trap | `tricky/os_08/os76_vs_08_trap.xlsx` | «старт» | Маршрут os_08, не os_76 |
| multi_mixed_book | `tricky/multi/multi_mixed_book.xlsx` | «старт» | Парсится лист OS01, не UK/Инструкция |
| multi_empty_active | `tricky/multi/multi_empty_active.xlsx` | «старт» | Данные с «Исходная выгрузка 01», не пустой Лист1 |
| from_target_source | `tricky/os_01/from_target_source.xlsx` + эталон `from_target_etalon.xlsx` | «как в эталоне» | Колонки как в эталоне, compare без массовых mismatch |
| composite_multi_date | `tricky/os_01/composite_multi_date.xlsx` | «вытащи инвентарный и дату» | Extract после парса |

---

## P2 — edge / негатив

| ID | Файл | Ожидание |
|----|------|----------|
| os01_shallow_tree | `tricky/edge/os01_shallow_tree.xlsx` | Плоский режим, 2 строки ОС |
| numbers_nbsp | `tricky/os_01/numbers_nbsp.xlsx` | Числа с NBSP парсятся |
| broker_no_section | `tricky/edge/broker_no_section.xlsx` | 0 строк или warning |
| broker_1f018_clean | `tricky/broker/broker_1f018_clean.xlsx` | ≥2 сделки из 1.2 |
| broker_1f018_alt_header | `tricky/broker/broker_1f018_alt_header.xlsx` | Альт. заголовок 1.2 |
| wrong_shifted_cols | `tricky/edge/wrong_shifted_cols.xlsx` | Мало строк / вопрос в чате |
| empty_file | `tricky/edge/empty_file.xlsx` | Понятная ошибка |

---

## REF — боевые эталоны

| ID | Файл | Примечание |
|----|------|------------|
| fas_os_sample | `tricky/reference/fas_os_sample.xlsx` | Копия «Пример для ТЗ ФАС- ОС.xlsx» |
| os76_multisheet | `tricky/reference/os76_multisheet.xlsx` | Multi-sheet карточка 76 |

---

## Шаблон отчёта прогона

| ID | Route OK | Parse OK | Rows | Columns OK | Notes | Pass |
|----|----------|----------|------|------------|-------|------|
| os01_hierarchy_clean | | | | | | ☐ |
| … | | | | | | |

---

## Result mode (после парса) — smoke-чеклист

На готовой таблице с **snapshot** (например `os01_hierarchy_clean` или `Пример по сч 76.xlsx`):

| # | Команда | Ожидание |
|---|---------|----------|
| 1 | «оставь только строки где ОС содержит 80-000001» | `filter_rows`, строк меньше, после F5 то же |
| 2 | «сделай новую таблицу …» (условие по колонке) | Новая вкладка snapshot, исходная не тронута |
| 3 | «вытащи инвентарный номер из колонки ОС» | Новая колонка справа |
| 4 | «проанализируй колонку ОС: аренда → rent» | `classify`, asset_class |
| 5 | «удали колонку Группа» | Колонка пропала в БД |
| 6 | «перенеси колонку Контрагент после Период» | Порядок headers сохраняется после F5 |
| 7 | «отмени последнее» (после шага 5 или 1) | Строки/колонка возвращаются |

Дополнительно:

- «разбери аналитику» на листе **Исходная КС** → `expand_ks_analytics`
- `npm run test` в `server`: `result_table_*`, `martin_tools`, `martin_converse` — зелёные

---

## Добавление новой фикстуры

1. Генератор в `server/fixtures/generators/node/` или `python/`
2. Запись в `manifest.json`
3. `npm run fixtures:generate`
4. `npm run test:fixtures`
5. Строка в этом чеклисте
