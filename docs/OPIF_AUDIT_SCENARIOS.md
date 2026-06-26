# ОПИФ-аудит Martin: сценарии и вывод

Каталог сценариев для аудита ОПИФ (УК, брокер, ДЕПО) в чате Martin. Источник правды в коде: [`server/audit_scenarios.js`](../server/audit_scenarios.js).

## Сценарии

| ID | Когда | Источники | Вывод |
|----|-------|-----------|-------|
| `opif_uk_broker` | «аудит с брокером» | УК + брокер | **Новая вкладка** |
| `opif_uk_depo` | «сверь с депо» (без брокера) | УК + ДЕПО | **Новая вкладка** |
| `opif_three_way` | «полный аудит», «брокер и депо» | УК + брокер + ДЕПО | **Новая вкладка** |
| `opif_enrich_depo` | «добавь депо» на вкладке отчёта | активный отчёт + ДЕПО | **In-place** (та же вкладка) |

## Примеры фраз

**Новый аудит (новая вкладка):**

- «Надо аудит. Сверяем с брокером. Результат в новую таблицу»
- «Сверь УК с депозитарием»
- «Полный аудит: брокер и депо»

**Дополнение (in-place):**

- «Добавь сверку с депо в текущую таблицу аудита»
- «Дополни отчёт колонками депо»

## Колонки результата

### opif_uk_broker

- База: все колонки УК
- Добавлено: `brokerFound`, `audit_result`, `audit_comment`, `broker_*`, `reconcile_status`
- Цвет: зелёный = `brokerFound`

### opif_uk_depo

- База: колонки УК
- Добавлено: `depoFound`, `ukGroupQty`, `depoGroupQty`, `audit_depo`, `audit_depo_comment`
- Логика: агрегат по ключу `дата|reg/isin|buy/sell` (как legacy `GET /audit`)
- Цвет: зелёный = `depoFound`

### opif_three_way

- Колонки: `registrationDate`, `operationType`, `name`, `regNum`, `isin`, `quantity`, `ukGroupQty`, `amount`, `currency`, `brokerFound`, `depoFound`, `depoGroupQty`, `audit_result`, `audit_depo`
- Цвет: зелёный только если `brokerFound && depoFound`

### opif_enrich_depo

- Сохраняются `brokerFound`, `audit_result`, `broker_*`
- Добавляются `depoFound`, `ukGroupQty`, `depoGroupQty`, `audit_depo`, `audit_depo_comment`
- Обновляется `reconcile_status` (оба OK → `match`)

## Типичный workflow

1. Разобрать УК (карт 58.1), брокер, ДЕПО в чате
2. «Аудит с брокером → новая таблица» → вкладка с `brokerFound`
3. Открыть вкладку отчёта → «Добавь сверку с депо» → те же строки + колонки ДЕПО

Альтернатива: сразу «Полный аудит брокер и депо» → одна вкладка со всеми флагами.

## Модули

| Модуль | Роль |
|--------|------|
| `server/audit_scenarios.js` | Каталог, детект сценария, промпт для LLM |
| `server/opif_legacy_audit.js` | Legacy-матчеры (брокер построчно, ДЕПО агрегат) |
| `server/reconcile_intent.js` | Regex-план, выбор источников |
| `server/reconcile_flow.js` | Оркестрация, роутинг matcher |
| `server/reconcile_report_import.js` | Новый snapshot / enrich in-place |

## Тесты

```bash
node --test server/opif_legacy_audit.test.js server/audit_scenarios.test.js server/reconcile_intent.test.js
```
