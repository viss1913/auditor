# Документы для внедрения «ИИ-аудитор» v1

Набор markdown-файлов для передачи Заказчику или вложения в договор (после заполнения плейсхолдеров).


| Файл                                                                   | Назначение                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [01-kommercheskoe-predlozhenie.md](./01-kommercheskoe-predlozhenie.md) | КП: ООО «ЦУПРФ», внедрение **1 300 000 ₽**, срок **2 мес.**, абон **100 000 ₽/мес.** + **10 ч**, сверх — **120 USD/ч** по курсу ЦБ на дату счёта, НДС не облагается |
| [02-plan-rabot.md](./02-plan-rabot.md)                                 | План работ по этапам                                                                                                   |
| [03-arhitektura.md](./03-arhitektura.md)                               | Архитектура и потоки данных (Mermaid)                                                                                  |
| [04-trebuemye-moshchnosti.md](./04-trebuemye-moshchnosti.md)           | Требования к серверам, GPU, сети, бэкапам                                                                              |
| [devops-meeting/00-paket-na-vstrechu.md](./devops-meeting/00-paket-na-vstrechu.md) | Пакет на встречу с DevOps: протокол, акт стенда, Ollama offline, deploy |
| [devops-meeting/04-kompyuternoe-zrenie.md](./devops-meeting/04-kompyuternoe-zrenie.md) | Vision LLM: сканы PDF/фото, GPU, env |

Перед отправкой клиенту: подставить реквизиты Заказчика и Исполнителя, сроки оплаты в днях, дату старта абонентской платы, форму учёта часов (акт/табель).

## Word (.docx) через Pandoc

Установка (Windows): `winget install --id JohnMacFarlane.Pandoc -e`

Один файл:

```powershell
pandoc docs\vnedrenie-v1\01-kommercheskoe-predlozhenie.md -o docs\vnedrenie-v1\docx\01-kommercheskoe-predlozhenie.docx
```

Все документы разом (из папки `docs\vnedrenie-v1`):

```powershell
.\docs\vnedrenie-v1\build-docx.ps1
```

Результат: каталог `docs\vnedrenie-v1\docx\`. Если в новом терминале `pandoc` «не найден», перезапусти терминал или Cursor (обновление PATH).

Блоки Mermaid в `03-arhitektura.md` в Word по умолчанию идут как код; для красивой схемы в документе — вставь диаграмму вручную или используй экспорт из другого инструмента.