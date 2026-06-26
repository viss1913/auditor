# Процедура offline-установки моделей Ollama (air-gap)

Документ для согласования с DevOps заказчика. Целевой режим: **без исходящего интернета** с prod-стенда.

---

## 1. Какие модели нужны

| Ollama tag | Назначение | Примерный размер |
|------------|------------|------------------|
| `gemma3:27b` | **Текст (мощный):** Martin, JSON-правила — аналог Gemma 3 27B IT | ~17 ГБ |
| `qwen2.5vl:32b` | **Vision (мощный):** сканы PDF/фото — аналог Qwen3-VL 32B | ~21 ГБ |
| `qwen2.5:7b-instruct` | Текст (базовый) | ~4.7 ГБ |
| `qwen2-vl:7b` | Vision (базовый) | ~8 ГБ |

**Мощный профиль:** `gemma3:27b` + `qwen2.5vl:32b` — **~40 ГБ на диск**, GPU **48 GB VRAM** комфортно.

**Базовый профиль:** 7b + qwen2-vl — ~15–20 ГБ на диск, GPU 16 GB.

**VRAM:** при 16 ГБ GPU модели работают по очереди; при 24 ГБ — комфортнее для параллельных запросов.

---

## 2. Вариант A — перенос через `ollama pull` + кэш (рекомендуем)

### Шаг 1. Подготовка на машине с интернетом (DMZ / ноутбук инженера)

```bash
# Установить Ollama той же версии, что будет на prod
curl -fsSL https://ollama.com/install.sh | sh

# Скачать модели (text + vision)
# Мощный профиль (рекомендуем)
ollama pull gemma3:27b
ollama pull qwen2.5vl:32b

# Базовый профиль
# ollama pull qwen2.5:7b-instruct
# ollama pull qwen2-vl:7b

# Проверка
ollama list
curl http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:7b-instruct","messages":[{"role":"user","content":"ping"}]}'
```

### Шаг 2. Упаковка кэша моделей

Кэш Ollama по умолчанию:

| ОС | Путь |
|----|------|
| Linux | `~/.ollama/models/` или `/usr/share/ollama/.ollama/models/` |
| systemd-сервис | см. `Environment=OLLAMA_MODELS=...` в unit-файле |

```bash
# Пример: архив кэша
sudo systemctl stop ollama 2>/dev/null || true
tar -czvf ollama-models-qwen.tar.gz -C ~/.ollama models/
sha256sum ollama-models-qwen.tar.gz > ollama-models-qwen.tar.gz.sha256
```

### Шаг 3. Перенос в air-gap

1. Записать архив на носитель / передать через согласованный канал (SFTP jump, Kaspersky sandbox, и т.д.).
2. На GPU-VM prod проверить checksum.
3. Распаковать в каталог моделей Ollama:

```bash
sudo systemctl stop ollama
sudo mkdir -p /usr/share/ollama/.ollama
sudo tar -xzvf ollama-models-qwen.tar.gz -C /usr/share/ollama/.ollama/
sudo chown -R ollama:ollama /usr/share/ollama/.ollama
sudo systemctl start ollama
ollama list
```

### Шаг 4. Smoke test на prod (без интернета)

```bash
curl http://127.0.0.1:11434/api/tags
curl http://127.0.0.1:11434/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5:7b-instruct","messages":[{"role":"user","content":"Ответь JSON: {\"ok\":true}"}]}'
```

---

## 3. Вариант B — перенос бинарника Ollama + offline import (Modelfile)

Если заказчик не принимает tar с кэшем:

1. На машине с интерnet скачать **deb/rpm пакет Ollama** той же версии.
2. Перенести пакет в air-gap, установить.
3. Перенести **Modelfile** + веса (GGUF) если используется vLLM/llama.cpp — **не наш основной путь**, только если Ollama запрещён.

Для Ollama предпочтителен **вариант A**.

---

## 4. Вариант C — внутренний registry mirror

Если у заказчика есть **Nexus / Artifactory / Harbor**:

1. Согласовать whitelist доменов на этапе первичной загрузки.
2. Один раз pull через mirror в DMZ.
3. Promote образов/артефактов во внутренний registry prod-сегмента.

*(Требует отдельного согласования с ИБ.)*

---

## 5. Установка Ollama на GPU-VM (Linux)

```bash
# Offline: перенести .deb/.rpm с машины подготовки
sudo dpkg -i ollama-linux-amd64.deb   # или rpm -i

# NVIDIA driver + CUDA — по стандарту заказчика
nvidia-smi

# systemd
sudo systemctl enable ollama
sudo systemctl start ollama
```

Пример override для пути моделей (`/etc/systemd/system/ollama.service.d/override.conf`):

```ini
[Service]
Environment="OLLAMA_MODELS=/var/lib/ollama/models"
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

**Безопасность:** на prod bind `0.0.0.0:11434` только внутри VLAN; firewall — доступ **только с VM1 app**.

---

## 6. Конфигурация приложения «ИИ-Аудитор»

В `.env` на VM1:

```env
LLM_PROVIDER=openai
LLM_BASE_URL=http://<LLM_HOST>:11434/v1
LLM_MODEL=qwen2.5:7b-instruct
QWEN_MODEL=qwen2.5:7b-instruct

VISION_LLM_BASE_URL=http://<LLM_HOST>:11434/v1
VISION_MODEL=qwen2-vl:7b
DOCUMENT_SCAN_ENABLED=1
```

Заменить `<LLM_HOST>` на hostname или IP GPU-VM.

---

## 7. Чеклист согласования с DevOps

| # | Вопрос | Решение заказчика |
|---|--------|-------------------|
| 1 | Какой канал переноса артефактов в air-gap? | |
| 2 | Кто подписывает/сканирует архив моделей? | |
| 3 | Где хранить кэш Ollama на prod? | |
| 4 | Версия Ollama зафиксирована? | |
| 5 | Кто обновляет модели (процедура патчей)? | |
| 6 | Мониторинг GPU (nvidia-smi / их агент)? | |

---

## 8. Ответственность

| Этап | Заказчик | Исполнитель |
|------|----------|-------------|
| Выделение GPU-VM, firewall | ✅ | |
| Канал переноса в air-gap | ✅ | консультация |
| Pull моделей на машине подготовки | ☐ | ✅ |
| Упаковка и checksum | ☐ | ✅ |
| Установка Ollama + распаковка на prod | ☐ совместно | ✅ |
| Настройка `.env` LLM_* | | ✅ |
| Smoke test | | ✅ |

---

*Версия: 1. Дата: ___________
