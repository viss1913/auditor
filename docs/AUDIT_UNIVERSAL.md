# Универсальный аудит Martin

Единый контур сверки для любых таблиц проекта. **LLM только строит план** (что с чем и по каким ключам), **детерминированный скрипт** выполняет матч и создаёт новый snapshot-отчёт с цветовой разметкой расхождений.

## Принципы

| Роль | Модуль |
|------|--------|
| Понять «что с чем» | `server/reconcile_plan_llm.js` + `server/reconcile_intent.js` |
| Сопоставить строки | `server/reconcile_engine.js` |
| Источники данных | `server/reconcile_sources.js`, `server/reconcile_catalog.js` |
| Отчёт-snapshot | `server/reconcile_report_import.js` |
| UI | `src/AiMartin.jsx`, `src/ExcelGridTable.jsx` |

**Не используем для нового аудита:** `/audit` на `trades`, `LyubovPanel`, OPIF sidebar (deprecated).

**ОПИФ-сценарии** (УК / брокер / ДЕПО): см. [`OPIF_AUDIT_SCENARIOS.md`](OPIF_AUDIT_SCENARIOS.md). Режимы вывода: `new_snapshot` (новая вкладка) и `enrich_active` (дополнение отчёта in-place).

## Источники

- `snapshot:N` — спарсенная таблица из чата
- `inbox:path` — файл в inbox проекта (ленивый парс через `reconcile_inbox_parse.js`)

Каталог для LLM: `GET /api/projects/:projectId/reconcile/sources` — id, имя, headers, 5 sample rows.

## API

| Метод | Назначение |
|-------|------------|
| `GET /api/parse/snapshots/:id/export?format=csv\|xlsx` | Экспорт таблицы |
| `GET /api/projects/:id/reconcile/sources` | Каталог источников |
| `POST /api/reconcile/plan` | LLM-план по `message` + `projectId` |
| `POST /api/reconcile/run` | `plan` → новый `snapshotId` отчёта |

Чат `/api/ai/converse`: intent «сверь» → plan → run → новая вкладка.

## План сверки (JSON)

```json
{
  "left": { "ref": "snapshot:385", "label": "УК 58.01" },
  "right": { "ref": "inbox:uk/карт 58.1_НР.xlsx", "label": "Брокер фев" },
  "leftKeys": ["period", "regNum"],
  "rightKeys": ["Дата", "ISIN"],
  "valuePairs": [
    { "left": "quantity", "right": "Количество", "tolerance": 0.01 }
  ],
  "join": "outer"
}
```

## Статусы строк

| `reconcile_status` | Цвет в UI |
|--------------------|-----------|
| `match` | зелёный |
| `value_mismatch` | жёлтый / оранжевые ячейки |
| `only_left` | красноватый |
| `only_right` | синеватый |

## UI

- Кнопки **CSV / XLSX** — экспорт активной вкладки
- **Сверить** — панель выбора источников, составление плана, «Запустить»
- Чат: `сверь`, `сверь таблицу A с B`, `сверь quantity по period и regNum`

## Тесты

```bash
node --test server/reconcile_engine.test.js
```
