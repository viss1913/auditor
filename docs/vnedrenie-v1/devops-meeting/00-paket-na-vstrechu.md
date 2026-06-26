# Пакет материалов на встречу с DevOps заказчика

**Продукт:** «ИИ-Аудитор» v1 (BankFuture / Martin)  
**Режим:** on-prem, Linux, локальная LLM (Ollama), без выхода в интернет  
**Дата встречи:** ___________

---

## Состав пакета

| № | Документ | Назначение |
|---|----------|------------|
| 1 | [01-protokol-vstrechi.md](./01-protokol-vstrechi.md) | Протокол встречи: чеклист, 10 вопросов, решения |
| 2 | [02-akt-gotovnosti-stenda.md](./02-akt-gotovnosti-stenda.md) | Акт готовности изолированного стенда ПСИ |
| 3 | [03-ollama-offline.md](./03-ollama-offline.md) | Процедура offline-установки моделей Ollama в air-gap |
| 4 | [04-kompyuternoe-zrenie.md](./04-kompyuternoe-zrenie.md) | Vision LLM: сканы PDF/фото, GPU, env, smoke test |
| 5 | [../03-arhitektura.md](../03-arhitektura.md) | Архитектура для ИБ и DevOps |
| 6 | [../04-trebuemye-moshchnosti.md](../04-trebuemye-moshchnosti.md) | Железо и ПО |
| 7 | [prilozhenie-4-dogovor.md](./prilozhenie-4-dogovor.md) | Приложение к договору — закупка |
| 8 | [../../../deploy/README.md](../../../deploy/README.md) | Инструкция развёртывания (nginx, systemd, docker) |
| 9 | [05-deploy-s-nashego-terminale.md](./05-deploy-s-nashego-terminale.md) | VPN + SSH: деплой правок с нашего терминала |

---

## Кратко для устной презентации (2 мин)

1. **Что ставим:** React UI + Node.js API + PostgreSQL + **Ollama на GPU (две модели: текст + зрение)**.
2. **Сколько VM:** 2 (приложение+БД и GPU-LLM) — рекомендуем; 1 VM возможна, но хуже.
3. **Данные не уходят наружу:** LLM только по внутреннему HTTP `:11434`.
4. **Компьютерное зрение:** отдельная **vision-модель** смотрит на **сканы PDF и фото** (договоры, акты, брокерские таблицы без текстового слоя) → JSON → таблица в Martin. Подробно: [04-kompyuternoe-zrenie.md](./04-kompyuternoe-zrenie.md).
5. **От заказчика:** VM, GPU **24 GB VRAM** (сбалансированный профиль + vision, см. ниже); 48 GB — если хотят 1:1 как dev; 16 GB — минимум.
6. **От нас:** установка ПО, миграции БД, Ollama + модели, nginx-конфиг, ПСИ.

---

## Сбалансированный профиль (рекомендуем на встрече) — **24 GB + vision**

**48 GB не обязательны.** Для prod с Gemma и сканами достаточно **24 GB GPU**.

| Роль | Ollama | VRAM | Комментарий |
|------|--------|------|-------------|
| Текст | `gemma3:27b` | ~18 GB | Как ваш Gemma 3 27B в dev |
| Vision | `qwen2-vl:7b` | ~8 GB | Сканы PDF/фото, брокер — **vision есть** |

Ollama на 24 GB держит **одну** модель → при скане подгружает vision, при чате — text. Пауза при переключении ~10–30 с — для аудита норм.

**Ещё проще:** одна `gemma3:27b` (multimodal) — text + vision в одной модели, одна `ollama pull`. Vision слабее, чем Qwen2-VL, но сканы идут.

Env: [deploy/.env.production.balanced.example](../../../deploy/.env.production.balanced.example)

---

## Максимальный профиль (если бюджет позволяет) — 48 GB

Как dev: Gemma 27B + Qwen2.5-VL **32B** одновременно без переключения.

| Роль | Ollama | VRAM |
|------|--------|------|
| Текст | `gemma3:27b` | ~18 GB |
| Vision | `qwen2.5vl:32b` | ~21 GB |

GPU **48 GB** (A6000, L40S, A100-40). Env: [deploy/.env.production.power.example](../../../deploy/.env.production.power.example)

---

## Базовый профиль (если GPU слабый / экономия)

| Модель | VRAM |
|--------|------|
| `qwen2.5:7b-instruct` + `qwen2-vl:7b` | **16 GB** по очереди |

Шаблон: [deploy/.env.production.example](../../../deploy/.env.production.example)

---

## Архитектура (схема)

```text
Пользователи → HTTPS :443 (nginx) → React static + proxy /api → Node :3001
                                              ↓
                                         PostgreSQL :5432
                                              ↓
                                    Ollama :11434 (GPU VM, HTTP)
                              ┌─────────┴─────────┐
                    gemma3:27b (text)     qwen2-vl:7b (vision)
                    [сбалансированный — 24 GB GPU, модели по очереди]
```

---

## Компьютерное зрение (кратко)

| | Текстовая LLM | Vision LLM |
|---|---------------|------------|
| **Задача** | Чат Martin, правила парсинга | OCR сканов, фото, брокерские PDF |
| **Модель** | `qwen2.5:7b-instruct` | `qwen2-vl:7b` |
| **Когда** | Всегда (если LLM вкл.) | PDF без текстового слоя, фото, fallback брокера |
| **VRAM** | ~5 ГБ | ~8 ГБ |

Подробно: [04-kompyuternoe-zrenie.md](./04-kompyuternoe-zrenie.md).

---

## Железо (ориентир закупки)

| Роль | CPU | RAM | Диск | GPU |
|------|-----|-----|------|-----|
| VM1: App + PostgreSQL | 8 ядер | 32 ГБ | SSD 250+ ГБ | — |
| VM2: **сбалансированный** | 8 ядер | 32 ГБ | SSD 150+ ГБ | **24 GB VRAM** (4090, L4, A5000) |
| VM2: максимальный | 8+ ядер | 64 ГБ | SSD 200+ ГБ | **48 GB VRAM** |
| VM2: базовый | 4+ ядер | 32 ГБ | SSD 100+ ГБ | **16 GB VRAM** |

---

## Модели Ollama (on-prem) — текст + зрение

| Модель | Назначение | VRAM |
|--------|------------|------|
| `qwen2.5:7b-instruct` | **Текст:** чат Martin, JSON-правила парсинга | ~5 ГБ |
| `qwen2-vl:7b` | **Vision:** сканы PDF, фото документов, заголовки брокерских таблиц | ~8 ГБ |

При **16 ГБ VRAM** модели работают **по очереди** (Ollama подгружает нужную). При **24 ГБ** — комфортнее при одновременных text + vision запросах.

Vision можно отключить: `DOCUMENT_SCAN_ENABLED=0` (остаётся только текстовая LLM и парсинг PDF с текстовым слоем).

---

## Экспорт в Word

```powershell
cd docs\vnedrenie-v1\devops-meeting
.\build-meeting-packet.ps1
```

Результат: каталог `docx/`.
