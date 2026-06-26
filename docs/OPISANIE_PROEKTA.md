# BankFuture Audit Platform — описание проекта

**Продукт:** универсальный ИИ-аудитор / аналитическая платформа  
**Рабочее название:** «Аудит Асоль», «Martin by BankFuture»  
**Репозиторий:** `auditor_3`  
**Дата документа:** июнь 2026  

---

## Содержание

1. [Глобальная задача](#1-глобальная-задача)
2. [Что мы хотим (целевое состояние)](#2-что-мы-хотим-целевое-состояние)
3. [Текущая архитектура](#3-текущая-архитектура)
4. [Кураторы — кто за что отвечает](#4-кураторы--кто-за-что-отвечает)
5. [Сценарии парсинга](#5-сценарии-парсинга)
6. [Как устроен AI Martin](#6-как-устроен-ai-martin)
7. [Оркестратор и autostart](#7-оркестратор-и-autostart)
8. [Режим результата — команды по таблице](#8-режим-результата--команды-по-таблице)
9. [Аудит ОПИФ (УК · Брокер · ДЕПО)](#9-аудит-опиф-ук--брокер--депо)
10. [Эталон и сверка (Ксения)](#10-эталон-и-сверка-ксения)
11. [Модель данных](#11-модель-данных)
12. [Настройка и развёртывание](#12-настройка-и-развёртывание)
13. [API — обзор](#13-api--обзор)
14. [Что сделано и что в плане](#14-что-сделано-и-что-в-плане)
15. [Как настраивать сценарии и правила](#15-как-настраивать-сценарии-и-правила)

---

## 1. Глобальная задача

Создать **универсального ИИ-аудитора** — рабочую среду, в которой аналитик или аудитор:

1. Загружает **разнородные данные** (Excel из 1С, PDF выписок, txt/csv, папки файлов, в перспективе — внешние БД).
2. Общается с **AI-ассистентом Martin** на естественном языке.
3. Получает **структурированные таблицы** (парсинг по настраиваемым правилам, а не хардкоду).
4. **Трансформирует** данные в чате: фильтры, извлечение полей, классификация, замена значений.
5. **Сверяет** несколько источников и находит расхождения.
6. Формирует **отчёты** (CSV сейчас; PDF/дашборды — в плане).

Ключевой принцип из ТЗ (`TZ_PLATFORM.md`):

> Система должна быть **универсальной** — не привязанной к одному сценарию. Конкретные бизнес-задачи (ОПИФ, ОС 1С, договоры) реализуются как **настраиваемые правила и сценарии**, а не как разовый код под каждый файл.

### Первые прикладные модули (MVP)

| Модуль | Задача | Статус |
|--------|--------|--------|
| **ОПИФ-аудит** | Сверка сделок УК ↔ Брокер ↔ ДЕПО | ✅ Работает |
| **Парсинг ОС/ОСВ 1С** | Ведомости, карточки счетов, деревья → плоская таблица | ✅ Работает (Martin) |
| **Парсинг УК 58.01** | Карточка счёта, проводки Дт 58.01 / Кт 76 | ✅ Работает |
| **Эталон + сверка** | Построение правила по образцу Excel | ✅ API готов |
| **Договоры / нетиповые Excel** | Отдельный контур | 🔲 Запланировано (Павел) |

### Развёртывание

Целевая модель — **on-prem в контуре заказчика**: PostgreSQL, Node.js, React, локальная LLM (Ollama / OpenRouter как прокси). Подробнее: `docs/vnedrenie-v1/03-arhitektura.md`.

---

## 2. Что мы хотим (целевое состояние)

### 2.1. Для пользователя-аудитора

- Один вход: **чат + таблица**, без десятка кнопок после парсинга.
- Прикрепил файл → Martin сам понял формат → показал превью → уточнил в чате при неоднозначности → записал результат в БД.
- Дальше всё через диалог: «оставь только 2024», «вытащи инвентарный номер из колонки ОС», «классифицируй по аренде/ремонту».
- Для ОПИФ: загрузил три источника → нажал аудит → увидел, где не сошлось.
- Для сложных кейсов: дал **эталон** (5–20 строк Excel) → система сама построила правило и сверила.

### 2.2. Для разработки / настройки

- **Сценарии** (`scenarioId`) — именованные пресеты: какой движок, какой layout, нужно ли дерево.
- **ParsingRule v2** (JSON) — декларативное описание: откуда брать колонки, как обходить дерево, метрики, composite-cell.
- **Кураторы** (Anton, Lyubov, Kseniya, Pavel) — изолированные зоны ответственности, свой код, своё хранилище.
- **Оркестратор** — план сессии: autodetect → вопросы → парс → snapshot.
- **Сохранённые правила** — fingerprint файла → подставить прошлое правило без вопросов.
- **Проекты** — рабочие пространства с чатами, правилами, снимками (API есть, UI project-centric — в развитии).

### 2.3. Чего пока нет (но в ТЗ)

- Универсальный движок аудита по JSON-правилам (сейчас ОПИФ захардкожен).
- Подключение внешних БД (PostgreSQL, MySQL, MS SQL).
- SSO, роли, админка.
- PDF-отчёты, дашборды.
- Docker Compose «из коробки».
- Единый `POST /api/parser-dispatch` (заготовка есть).

---

## 3. Текущая архитектура

```
┌──────────────────────────────────────────────────────────────────┐
│  БРАУЗЕР  React 19 + Vite 7                                      │
│  ┌─────────────────────┐  ┌──────────────────────────────────┐  │
│  │  Таблица результата │  │  Чат Martin (основной UX)         │  │
│  │  вкладки, поиск,    │  │  файлы, вопросы, команды          │  │
│  │  пагинация          │  │                                   │  │
│  └─────────────────────┘  └──────────────────────────────────┘  │
│  App.jsx · AiMartin.jsx · LyubovPanel · KseniyaPanel             │
└───────────────────────────────┬──────────────────────────────────┘
                                │ REST / multipart  :5173 → :3001
┌───────────────────────────────┴──────────────────────────────────┐
│  NODE.JS + EXPRESS                                               │
│  index.js          — ОПИФ: upload, trades, audit                   │
│  ai_parser_api.js  — Martin: batch-start, chat, snapshots         │
│  kseniya_api.js    — txt/csv 1С                                    │
│  scenario_router   — файл → scenarioId                           │
│  orchestrator/     — план сессии, вопросы                          │
│  parse_engine.js   — ParsingRule v2                                │
│  tree_walker.js    — иерархии ОС/ОСВ                               │
│  llm_client.js     — OpenAI-compatible LLM                         │
└───────────────────────────────┬──────────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────────┐
│  POSTGRESQL                                                        │
│  trades              — сделки ОПИФ (UK/Broker/DEPO)                │
│  parse_snapshots +   — большие таблицы Martin (JSONB строки)       │
│  parsed_rows                                                       │
│  parsing_rules       — сохранённые JSON-правила                    │
│  chat_sessions, chat_history                                       │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTP (опционально)
┌───────────────────────────────┴──────────────────────────────────┐
│  LLM  — Ollama / OpenRouter / Qwen и др.                           │
│  Python openpyxl probe (опционально)                               │
└────────────────────────────────────────────────────────────────────┘
```

### Ключевые файлы

| Область | Путь |
|---------|------|
| ТЗ платформы | `TZ_PLATFORM.md` |
| Быстрый старт ОПИФ | `README.md` |
| Маршрутизация кураторов | `docs/parser-routing.md` |
| Схема меню ЛК | `docs/lk-menu-schema.md` |
| Внедрение v1 | `docs/vnedrenie-v1/` |
| UI Martin | `src/AiMartin.jsx`, `src/martin-v2.css` |
| Ядро API Martin | `server/ai_parser_api.js` |
| Каталог сценариев | `server/scenarios/catalog.js`, `registry.js` |
| Примеры правил | `server/rules/examples/` |

---

## 4. Кураторы — кто за что отвечает

Идея: у каждого «куратора» свой формат данных, свой парсер и (в Cursor) свой субагент. Общий роутер только направляет. **Данные не смешиваются.**

| ID | Имя | Статус | Зона ответственности | UI | Хранилище |
|----|-----|--------|----------------------|-----|-----------|
| `anton` | **Антон** | ✅ ready | Excel/PDF/папки 1С: ОС, ОСВ, УК, txt; Martin; snapshots | `AiMartin.jsx` | `parse_snapshots`, `parsed_rows` |
| `lyubov` | **Любовь** | ✅ ready | ОПИФ: УК, Брокер, ДЕПО, аудит трёх сторон | `App.jsx` (раздел ОПИФ), `LyubovPanel.jsx` | `trades` |
| `kseniya` | **Ксения** | ✅ ready (UI частично) | Эталон Excel, сверка колонок; txt 1С (карточка 90, реестр) | `KseniyaPanel.jsx` + target в Martin | Снимки Антона + target-файл |
| `pavel` | **Павел** | 🔲 planned | Нетиповые Excel, договорная документация | `ParserPlaceholder.jsx` | TBD |

Реестры:
- Фронт: `src/parserProfiles.js`
- Бэк: `server/parser_registry.js`
- API: `GET /api/parser-profiles`, `GET /api/parser-profiles/:id`

Cursor-агенты (промпты): `.cursor/agents/anton.md`, `lyubov.md`, `kseniya.md`, `pavel.md`.

---

## 5. Сценарии парсинга

Сценарий — это **именованный пресет**: тип layout, движок парсинга, нужно ли подтверждение дерева, порог уверенности autodetect.

Источник истины: `server/scenarios/catalog.js` + пресеты с подсказками для чата в `server/scenarios/presets/*.json`.

### 5.1. Полный каталог

| scenarioId | Название | Layout | Движок | Дерево | minConfidence |
|------------|----------|--------|--------|--------|---------------|
| `uk_card` | Карточка УК 58.01 | fixed_columns | parse_engine | нет | 0.88 |
| `os_76_account_card` | Карточка счёта 76 | hierarchy_osv | tree_walker | да | 0.90 |
| `os_08_osv` | ОСВ 08 | hierarchy_osv | tree_walker | да | 0.85 |
| `os_01_hierarchy` | Ведомость ОС с деревом | hierarchy_rows | tree_walker | спросить | 0.70 |
| `os_01_flat` | Ведомость ОС плоская | hierarchy_rows | tree_walker | нет | 0.70 |
| `os_01_cost_only` | ОС — только стоимость | hierarchy_rows | tree_walker | спросить | 0.70 |
| `wide_metrics` | ОС — годы в колонках | wide_metrics | parse_engine | нет | 0.85 |
| `from_target` | Как в эталоне | — | target_rule_infer | нет | 1.0 |
| `card_90_tsv` | Карточка 90 (txt) | fixed_columns | parse_1c_tsv | нет | 1.0 |
| `deals_registry_tsv` | Реестр сделок (txt) | fixed_columns | parse_1c_tsv | нет | 1.0 |
| `opif_depo` | ОПИФ — выписки ДЕПО (PDF) | fixed_rows | parse_depo | нет | 1.0 |
| `opif_broker` | ОПИФ — отчёт брокера (1.2) | fixed_rows | parse_broker | нет | 1.0 |

### 5.2. Что означают сценарии ОС (подробно)

#### `os_01_hierarchy` — ведомость 01 с иерархией
- Типичный файл: амортизационная ведомость ОС из 1С.
- Дерево: **Группа → Узел (РТК/КЦ) → Подразделение (ОП) → ОС** + метрики (стоимость, амортизация).
- Подсказки в чате: «с группой и ОП», «с РТК», «развернуть иерархию».
- После разворота: каждая строка ОС — отдельная запись, предки — в колонках.

#### `os_01_flat` — плоская ведомость
- Только строки листового уровня: год, тип, метрики без полной иерархии.
- Подсказки: «плоская таблица», «только год и тип».

#### `os_01_cost_only` — без амортизации
- Как hierarchy, но фокус на стоимости без колонок амортизации.

#### `os_08_osv` — оборотно-сальдовая 08
- Дерево счетов/субконто, обороты и сальдо.
- Если пользователь пишет «это ОСВ 08» / «оборотка» — маршрутизатор выбирает этот сценарий.

#### `os_76_account_card` — карточка счёта 76
- Иерархия как в карточке 76-го счёта (контрагенты, договоры, документы).

#### `wide_metrics` — годы в колонках
- Годы (2020, 2021, …) — отдельные колонки метрик, не строки.

#### `uk_card` — карточка УК 58.01
- Фиксированные колонки, проводки Дт 58.01 / Кт 76.
- Отдельный контур от ведомости ОС; детект по `profile_hint: uk_card`.

### 5.3. Сценарии ОПИФ

#### `opif_broker`
- Excel, файлы с префиксом **`1F018_`** (настраивается из чата: «возьми файлы, которые начинаются с …»).
- Парсер ищет **Раздел 1.2** — неисполненные сделки.
- В Martin: batch-start кладёт результат в **snapshot**, не в `trades`.

#### `opif_depo`
- PDF выписки о движении ЦБ.
- Зачисление / Списание, рег. номер, ISIN, количество.

### 5.4. Текстовые выгрузки 1С

#### `card_90_tsv` / `deals_registry_tsv`
- `.txt`, `.csv`, `.tsv` с табуляцией/разделителем 1С.
- Парсер: `server/parse_1c_tsv.js`.

### 5.5. Эталон

#### `from_target`
- Пользователь загружает **исходник + эталон** (Excel 5–20 строк с нужными колонками).
- `target_rule_infer.js` строит маппинг заголовков → поля правила **без LLM**.
- `compare_target.js` сверяет preview с эталоном (до ~5000 строк в MVP).

### 5.6. Autodetect — как файл попадает в сценарий

Цепочка (`server/scenario_router.js` → `resolveUpload`):

1. **PDF** → `opif_depo`
2. **txt/csv/tsv** (text_1c) → `card_90_tsv` или `deals_registry_tsv` по содержимому
3. **Excel** → `analyze_layout.js` → `tree_inference`, `column_catalog`, `uk_probe` → `detectSuggestedScenario()` в `registry.js`

Дополнительно текст пользователя разбирается в `structure_resolve.js`:
- «депо», «брокер», «08», «ук», «плоско», «эталон», префикс файлов и т.д.

Ключевые слова → scenario (`registry.resolveScenarioFromMessage`):
- «плоско» → `os_01_flat`
- «08», «осв», «оборотн» → `os_08_osv`
- «76» → `os_76_account_card`
- «эталон» → `from_target`
- «депо» → `opif_depo`
- «брокер», «1f018» → `opif_broker`

---

## 6. Как устроен AI Martin

Martin — главный UX платформы. Экран: **таблица слева + чат справа**, без левого меню (fullscreen на AI Martin).

Файлы: `src/AiMartin.jsx`, `src/martin-v2.css`, `server/ai_parser_api.js`.

### 6.1. Режимы работы

| Режим | `workMode` | Когда | Что можно |
|-------|------------|-------|-----------|
| **Исходник** | `source` | Файл прикреплён, парс не завершён | Probe, batch-start, ответы на вопросы оркестратора |
| **Результат** | `result` | Таблица готова (snapshot или draft preview) | Фильтр, extract, classify, удаление колонок, замена значений |

Переход в `result` происходит после успешного `batch-start` или когда команда явно относится к готовой таблице.

### 6.2. Основной пользовательский поток

```
1. Пользователь прикрепляет файл(ы) скрепкой в чате
      ↓
2. (Опционально) probe — POST /api/parse/probe
   «Похоже на os_01_hierarchy, 3 листа, PDF: 0»
      ↓
3. Пользователь пишет задачу или «старт» → POST /api/parse/batch-start
      ↓
4. Бэкенд: layout → orchestrator → scenario → rule v2 → parse → snapshot
      ↓
5. Martin отвечает в чате; таблица появляется слева (вкладки при multi-sheet)
      ↓
6. Если неоднозначность — вопрос ТОЛЬКО текстом в чате (без кнопок):
   «Развернуть в плоскую таблицу?» → пользователь: «да, разверни»
      ↓
7. Дальнейшие команды в чате → POST /api/ai/result-table-action
```

### 6.3. Типы загрузки в чате

| Действие | Что происходит |
|----------|----------------|
| **Файл или несколько** | Excel, PDF, txt — в staging |
| **Папка целиком** | `webkitdirectory`, до 200 файлов в batch |
| **Эталон Excel** | `targetFile` для сценария `from_target` и compare |

### 6.4. Batch-start — сердце парсинга

`POST /api/parse/batch-start` (`server/ai_parser_api.js`):

- Один или много файлов + опционально `target` + `userMessage` + `orchestratorAnswers`.
- **OPIF:** PDF → depo pipeline; Excel `1F018_*` → broker.
- **Excel ОС:** `runMartinSession()` — полный цикл оркестратора.
- **Multi-sheet:** если в книге несколько листов — `parseAllSheets`, отдельные snapshots / вкладки.
- **Text 1C:** отдельный autostart для tsv.

Ответ содержит: `parsePreview`, `snapshotId`, `assistantMessage`, `currentQuestion`, `pendingQuestions`, `needsScenarioChoice`, `scenarioId`, `layoutAnalysis`.

### 6.5. Вопросы оркестратора (только через чат)

Кнопки после парсинга **убраны**. Martin задаёт вопрос текстом; пользователь отвечает текстом.

Типы вопросов (`server/orchestrator/session_plan.js`):

| questionId | Когда | Примеры ответов в чате |
|------------|-------|------------------------|
| `pick_tree_flatten` | Обнаружено дерево в Excel | «да», «разверни», «нет, это ОСВ 08» |
| `pick_scenario` | Несколько подходящих сценариев | «плоская таблица», «с деревом» |
| `pick_sheet` | Несколько листов | название листа или «лист: Исходные ОС» |
| `pick_name_column` | Неясна колонка наименования | «колонка B», «колонка 1» |
| `pick_uk_quantity_column` | УК: количество не в той колонке | «колонка I» |
| `pick_composite_column` | Составная ячейка (ОС + инв. + дата) | номер/буква колонки |
| `pick_composite_field` | Что извлекать из ячейки | «инвентарный номер», «дата» |

Разбор ответов:
- Фронт: `resolveQuestionAnswerFromText()` в `AiMartin.jsx` → при неудаче `POST /api/ai/resolve-answer` (regex + Gemini).
- Бэк: `orchestrator/answer_resolve.js`, `applyAnswer()` + повторный `buildSessionPlan`.

**Умный диалог** (`MARTIN_SMART_DIALOG=1`):
- Autostart **не глотает** неоднозначности — задаёт `pick_scenario` / `pick_tree_flatten`.
- На первом проходе batch-start: черновик + вопрос, без commit в БД до ответа.
- `assist_martin.js` — объяснения через Gemini (дерево, брокер, compare).

### 6.6. Черновик (tentative preview)

Если нужно подтверждение (дерево, сценарий):
- Показывается **черновик** таблицы (`previewIsTentative: true`) без записи в БД.
- После подтверждения в чате — полный парс → `snapshotId` в Postgres.

### 6.7. Чат-сессии и история

- `POST /api/projects/:projectId/chats` — новая сессия.
- Snapshots привязываются к чату (`chat_session_snapshots`).
- История: `chat_history` + drawer «История» в UI.
- Пагинация таблицы: `GET /api/parse/snapshots/:id/rows?page=&limit=200`.

---

## 7. Оркестратор и autostart

Модули: `server/orchestrator/`.

### 7.1. `buildSessionPlan(layoutMeta, target, currentRule, opts)`

Вход: метаданные layout после `analyze_layout`, эталон, сохранённое правило, ответы пользователя.

Шаги:
1. `applyAutostartDefaults()` — подставить сценарий, лист, колонку имени без вопросов где возможно.
2. `detectSuggestedScenario()` — эвристики по layout.
3. `resolveStructureFromMessage(userMessage)` — разбор текста чата.
4. `matchSavedRule()` — fingerprint → прошлое правило из `parsing_rules`.
5. Сбор `pendingQuestions` если данных не хватает.
6. `isReadyToParse` — можно ли парсить сразу.

### 7.2. Autostart (`server/autostart_defaults.js`)

Цель: **минимум вопросов** на первом проходе.

- Если есть `tree_inference` → автоматически `pick_tree_flatten = 'confirm'`.
- `profileKey` дерева → scenario:
  - `os_76_card` → `os_76_account_card`
  - `os_08` → `os_08_osv`
  - `os_01` → `os_01_hierarchy`
- Автовыбор `sheetName`, `nameColumn` из кандидатов catalog.

**Первый проход** (`isFirstPass` в `runMartinSession`): если план готов — сразу полный парс в БД.  
**Второй и далее**: уточнения, черновик, вопросы.

### 7.3. ParsingRule v2

Схема: `server/schemas/parsing_rule_v2.schema.json`  
Валидация: `server/parsing_rule_v2_validate.js`  
Сборка из сценария: `server/scenarios/registry.js` → `applyScenario()` → примеры в `server/rules/examples/`.

Движки исполнения:
- `parse_engine.js` — fixed columns, wide metrics, uk_card.
- `tree_walker.js` / `hierarchy_walker.js` — обход дерева, разворот в плоскую таблицу.

---

## 8. Режим результата — команды по таблице

После появления таблицы пользователь пишет команды в чат.  
**Основной путь:** `POST /api/parse/snapshots/:id/apply-operation` → `parse_snapshot_operations.js` (все мутации в БД).  
**Fallback (только превью):** `POST /api/ai/result-table-action` → `result_table_commands.js` + `result_table_llm.js` + общий `resolveTableCommand`.

Команды `replace_values`, `expand_ks_analytics`, move/rename/add column, `undo_last` требуют snapshot (`needsSnapshot: true` в preview-path).

### Поддерживаемые действия

| action | Пример в чате | Что делает |
|--------|---------------|------------|
| `filter_rows` | «оставь только 2024», `name=ОСВ` | Фильтрация строк |
| `split_to_table` | «сделай новую таблицу ВТБ» | Копия строк в новый snapshot |
| `extract` | «вытащи инвентарный номер и дату из колонки ОС» | Новые колонки из текста ячейки |
| `clean_source` | «убери из колонки ОС номер и дату» | Очистка исходной ячейки |
| `classify` | «классифицируй по аренде/ремонту» | LLM-классификация (лимит ~120 строк) |
| `replace_values` | «если "Списание ЦБ" то замени на продажа» | Замена значений в колонке (snapshot) |
| `expand_ks_analytics` | «разбери аналитику» | Раскрытие Аналитика Дт/Кт (snapshot) |
| `delete_column` | «удали колонку Группа» | Удаление колонки |
| `move_column` | «перенеси колонку Контрагент после Период» | Порядок колонок |
| `rename_column` | «переименуй колонку Группа в Категория» | Переименование |
| `add_column` | «добавь колонку Комментарий» | Пустая колонка |
| `duplicate_column` | «скопируй колонку ОС как ОС копия» | Дубликат |
| `undo_last` | «отмени последнее» | Откат filter_rows / delete_column (v1) |

Планировщик: сначала **детерминированные regex** (`result_table_resolve.js` / `resolveTableCommand`), при необходимости — **LLM planner**.

Операции логируются в `table_operations` (с `rollback_payload` для undo v1). Рецепты (цепочки команд) — `table_recipes` (API есть).

---

## 9. Аудит ОПИФ (УК · Брокер · ДЕПО)

Куратор: **Любовь**. UI: раздел «Аудит ОПИФ» в `App.jsx`, хаб `LyubovPanel.jsx`.

### 9.1. Загрузка

`POST /upload` с `type`: `uk` | `broker` | `depo`

| Источник | Формат | Парсер | Куда |
|----------|--------|--------|------|
| УК | Excel | `parse_uk.js` / `parse_engine` | `trades`, source=UK |
| Брокер | Excel `1F018_*` | `parse_broker.js` | `trades`, source=Broker |
| ДЕПО | PDF | `parse_depo.js` | `trades`, source=DEPO |

Режимы: **заменить всё** / **добавить к текущим**.

### 9.2. Логика аудита

`GET /audit` — для каждой строки УК:

**УК ↔ Брокер** — совпадение по:
- дата регистрации
- бумага (reg_number или ISIN)
- количество
- сумма (±1 руб.)

**УК ↔ ДЕПО** — ДЕПО агрегирован по дню:
1. Суммируем кол-во УК по (дата рег. + бумага + тип buy/sell).
2. Ищем в ДЕПО запись с тем же ключом и **суммарным** количеством.

`GET /audit/preview` — подготовка: ключи, пересечения, счётчики.

### 9.3. ОПИФ через Martin

`server/opif_martin.js` — broker/depo в batch-start Martin → **snapshots**, не `trades`.  
Для классического аудита три стороны по-прежнему через Lyubov / `trades`.

---

## 10. Эталон и сверка (Ксения)

### API

| Endpoint | Назначение |
|----------|------------|
| `POST /api/parse/infer-from-target` | Исходник + эталон → rule v2 + preview |
| `POST /api/parse/compare-target` | Сверка preview с эталоном |
| `POST /api/kseniya/parse-text` | txt/csv 1С без Excel |

### Поток в Martin

1. Прикрепить исходник + **Эталон Excel** (меню скрепки).
2. Batch-start с `target` → `scenarioId = from_target`.
3. `comparePreviewToTarget()` — matched / missing / mismatch (до 50 расхождений в ответе).

### UI

- `KseniyaPanel.jsx` — парсинг txt (карточка 90, реестр сделок).
- Полный compare UI отдельной панелью — в развитии; API и Martin уже умеют.

---

## 11. Модель данных

### Два контура (не смешивать!)

```
ОПИФ (Любовь)                    Martin (Антон)
─────────────                    ──────────────
trades                           parse_snapshots
  period, security_name            headers JSONB
  reg_number, isin                 row_count, scenario_id
  quantity, amount                 status
  source: UK|Broker|DEPO           parsed_rows
  operation_type, fee                data JSONB per row
```

### Основные таблицы

| Таблица | Назначение |
|---------|------------|
| `trades` | Нормализованные сделки ОПИФ |
| `projects` | Рабочие пространства |
| `parsing_rules` | JSON-правила v1/v2, версии, fixture |
| `parse_snapshots` | Метаданные разбора Martin |
| `parsed_rows` | Строки таблицы (JSONB) |
| `table_operations` | История команд над snapshot |
| `table_recipes` | Сохранённые цепочки трансформаций |
| `chat_sessions` | Сессии чата |
| `chat_session_snapshots` | M:N чат ↔ snapshot |
| `chat_history` | Сообщения user/assistant |

Схема: `db/schema.sql`, миграции: `node server/migrate_db.js`.

---

## 12. Настройка и развёртывание

### 12.1. Запуск локально

```powershell
# 1. Бэкенд (из папки server)
cd server
node index.js
# → http://localhost:3001

# 2. Фронт (из корня)
npm run dev
# → http://localhost:5173
```

### 12.2. Переменные окружения (`.env` в корне)

**PostgreSQL:**
```env
DB_HOST=localhost
DB_PORT=5432
DB_NAME=auditor
DB_USER=postgres
DB_PASSWORD=...
```

**LLM (Gemini — основной, OpenRouter — fallback):**
```env
LLM_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.0-flash

# Fallback (OpenRouter / Ollama)
LLM_FALLBACK_PROVIDER=openai
LLM_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_API_KEY=...
QWEN_MODEL=qwen/qwen-2.5-7b-instruct
LLM_TIMEOUT_MS=20000

# Умный Martin
MARTIN_SMART_DIALOG=1          # вопросы вместо молчаливого autostart
MARTIN_USE_LLM_AUTOSTART=1     # LLM в приветствии
MARTIN_USE_TOOLS=1             # tool-calling (filter, classify, answer_question)
MARTIN_BROKER_LLM_PROBE=1      # LLM-поиск секции 1.2 если regex дал 0 строк
```

**Python probe (опционально, для тяжёлых Excel):**
```env
PYTHON_PATH=python
EXCEL_PROBE_TIMEOUT_MS=180000
```

### 12.3. Первичная настройка БД

```powershell
node server/migrate_db.js
```

### 12.4. Тесты

```powershell
cd server
npm test                  # базовые + fixtures_matrix + scenario_router
npm run test:fixtures     # матрица tricky Excel (47 тестов)
npm run test:all          # все *.test.js
npm run fixtures:generate # пересоздать tricky xlsx
```

Обширный набор: парсеры, orchestrator, snapshots, compare, batch-start, tree walker и др.

**Матрица tricky-фикстур:** [`docs/TEST_FIXTURES.md`](TEST_FIXTURES.md) — чеклист ручной проверки через Martin. Реестр: `server/fixtures/manifest.json`, файлы в `server/fixtures/tricky/`.

---

## 13. API — обзор

### ОПИФ (`server/index.js`)

| Method | Path | Описание |
|--------|------|----------|
| GET | `/ping` | Health |
| POST | `/upload` | Загрузка UK/Broker/DEPO |
| GET | `/trades?source=` | Список сделок |
| DELETE | `/trades?source=` | Очистка источника |
| GET | `/audit/preview` | Превью ключей сверки |
| GET | `/audit` | Полный аудит |

### Martin (`server/ai_parser_api.js`, префикс `/api`)

**Парсинг:** `/parse/probe`, `/parse/batch-start`, `/parse/auto-start`, `/parse/analyze-layout`, `/parse/scenarios`, `/parse/infer-from-target`, `/parse/compare-target`

**Snapshots:** `/parse/snapshots/:id`, `/parse/snapshots/:id/rows`, `/parse/snapshots/:id/apply-operation`

**AI:** `/ai/chat`, `/ai/result-table-action`, `/ai/enrich-column`, `/ai/generate-rule-from-file`

**Проекты и правила:** `/projects`, `/parsing-rules`, `/projects/:id/chats`, `/chats/:id`

**Профили:** `/parser-profiles`, `/parser-profiles/:id`, `/parser-dispatch` (заготовка)

### Ксения

| Method | Path |
|--------|------|
| POST | `/api/kseniya/parse-text` |

---

## 14. Что сделано и что в плане

### ✅ Реализовано

| Область | Детали |
|---------|--------|
| **ОПИФ парсинг** | UK, Broker, DEPO; upload; trades |
| **ОПИФ аудит** | UK↔Broker↔DEPO, preview, фильтры, CSV |
| **AI Martin v2** | Чат-first UX, batch-start, snapshots, multi-sheet, история чатов |
| **Парсинг ОС 1С** | 12 сценариев, tree_walker, parse_engine v2 |
| **Оркестратор** | Autostart, вопросы, saved rules fingerprint |
| **Режим результата** | filter, extract, classify, replace, delete column |
| **Snapshots в Postgres** | Пагинация 200 строк, operations, recipes API |
| **OPIF в Martin** | broker/depo batch → snapshots |
| **Ксения API** | infer-from-target, compare-target, parse-text |
| **Кураторы** | Anton, Lyubov, Kseniya — ready; реестр + ParserHub |
| **Тесты** | 40+ test-файлов в server/ |
| **UI** | Fullscreen Martin, чат без кнопок после парса |

### 🟡 Частично / MVP

| Область | Статус |
|---------|--------|
| Универсальная модель ТЗ | `trades` вместо абстрактных `records`; нет `audit_rules` в БД |
| Project-centric UI | API projects/chats есть, основной UX — один Martin |
| LLM tool-calling | `martin_tools.js`: answer_question, filter_table, classify_column, set_file_prefix (`MARTIN_USE_TOOLS=1`) |
| Kseniya compare UI | API готов, отдельная панель сверки — нет |
| OPIF Martin → trades | Snapshots отдельно от trades, без ETL |
| Excel Python probe | Опционально |
| smart_parse_uk v1 | Сосуществует с parse_engine v2 |

### 🔲 Запланировано

| Область | Куратор / раздел |
|---------|------------------|
| Нетиповые Excel, договоры | Павел |
| Аудит договоров | UI-заглушка |
| Аудит сделок (отдельный раздел) | UI-заглушка |
| Исходные файлы ОПИФ (хранилище) | Заглушка |
| Внешние БД, SSO, Docker, PDF-отчёты | TZ / vnedrenie |
| Универсальный audit engine по JSON | Только ОПИФ хардкод |
| `POST /api/parser-dispatch` | Метаданные only |

---

## 15. Как настраивать сценарии и правила

### 15.1. Добавить новый сценарий

1. **`server/scenarios/catalog.js`** — запись в `SCENARIO_CATALOG` (id, name, layoutType, engine, needsTree, minConfidence).
2. **`server/scenarios/presets/<id>.json`** — описание + `chatHints` для подсказок в чате.
3. **`server/rules/examples/<rule>.json`** — пример ParsingRule v2.
4. **`server/scenarios/registry.js`** — логика `detectSuggestedScenario`, `applyScenario`, `resolveScenarioFromMessage`.
5. При необходимости — тест в `server/scenarios/registry.test.js`.

### 15.2. Подсказки для чата (presets)

Пример `server/scenarios/presets/os_01_hierarchy.json`:
```json
{
  "id": "os_01_hierarchy",
  "name": "С деревом",
  "description": "Группа, Узел (РТК/КЦ), Подразделение (ОП), ОС, метрики",
  "chatHints": ["с группой и ОП", "с РТК", "развернуть иерархию"]
}
```

Пользователь может написать любую из подсказок вместо выбора кнопки.

### 15.3. Сохранённые правила

- Правила в `parsing_rules` с привязкой к `project_id`.
- Fingerprint layout → `matchSavedRule()` в orchestrator.
- API: `POST /api/parsing-rules`, `GET /api/parsing-rules/:project_id`, clone.

### 15.4. Боевые правила ФАС

- `server/rules/fas_os_01.json`, `fas_os_08.json` — эталонные правила под конкретные форматы заказчика.

### 15.5. Настройка LLM

- Локально: Ollama + `LLM_BASE_URL=http://localhost:11434/v1`.
- Облако: OpenRouter + `OPENROUTER_API_KEY`.
- Autostart без LLM работает на шаблонах (`assist_martin.js`); LLM улучшает формулировки и сложные команды.

### 15.6. Настройка ОПИФ брокера

- Префикс файлов по умолчанию: `1F018_`.
- Из чата: «возьми файлы, которые начинаются с X» → `structure_resolve.extractFilePrefixFromText`.

### 15.7. Cursor-агенты для разработки

В чате Cursor:
```
Use the anton subagent to parse this OS file...
Use the lyubov subagent to run OPIF audit...
Use the kseniya subagent to compare with target...
```

---

## Связанные документы

| Документ | О чём |
|----------|-------|
| `TZ_PLATFORM.md` | Полное ТЗ v1.0 |
| `README.md` | ОПИФ: загрузка, аудит, карта файлов |
| `docs/parser-routing.md` | Кураторы и разделение данных |
| `docs/lk-menu-schema.md` | Навигация личного кабинета |
| `docs/vnedrenie-v1/` | Коммерция, план, архитектура, мощности |
| `Приложение № 5 Архитектура системы ИИ-Аудитор v1.md` | Архитектура для заказчика |

---

*Документ отражает состояние кодовой базы на июнь 2026. При изменении сценариев или API обновляйте соответствующие разделы.*
