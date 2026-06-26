# Деплой с нашего терминала (пилот / активная разработка)

На этапе пилота с частыми правками **нормально и удобно**: DevOps заказчика даёт доступ, мы деплоим по SSH с своей машины (или через их VPN/jump-host).

---

## Что попросить у DevOps

| Доступ | Зачем | На сколько |
|--------|-------|------------|
| **VPN** или jump-host в периметр | Достучаться до VM извне | На период пилота + ПСИ |
| **SSH** на VM1 (app) | Деплой, логи, рестарты | Отдельная учётка, не root |
| **SSH** на VM2 (GPU) — опционально | Ollama, `ollama list`, логи GPU | Только если Ollama ставим мы |
| **sudo** или группа `docker` | `systemctl restart`, `docker compose` | Ограниченно, через sudoers |
| **Путь деплоя** | Например `/opt/auditor` | Зафиксировать |
| **Файл `.env`** | Секреты на сервере, не в git | Они создают, мы правим по SSH |

**Не просим:** root без нужды, доступ в prod AD, их пароли от Ollama в открытую в чате.

### Типовая учётка

```text
user: auditor-deploy
/home/auditor-deploy/.ssh/authorized_keys  ← ваш публичный ключ
groups: docker (если compose) или auditor + sudo для systemctl
```

---

## Схема

```text
Ваш ноутбук (Cursor / PowerShell / bash)
        │  VPN
        ▼
Jump-host / корпсеть
        │  ssh auditor-deploy@vm1-app
        ▼
VM1 /opt/auditor  ──HTTP :11434──►  VM2 Ollama
```

LLM API (`LLM_BASE_URL`) уже настроен в `.env` на VM1 — вам не нужен SSH на GPU для каждого деплоя приложения.

---

## Вариант A — git pull на сервере (проще всего)

**Один раз:** на VM1 клон репо, SSH deploy key read-only в их GitLab/GitHub **или** bare repo у них.

**Каждый деплой** (с вашего терминала):

```bash
ssh auditor-deploy@vm1-app 'cd /opt/auditor && git pull && npm ci && npm run build && cd server && npm ci && cd .. && sudo systemctl restart auditor-api'
```

Или короче — скрипт `deploy/deploy-remote.sh` (см. ниже).

---

## Вариант B — rsync с вашей машины (без git в периметре)

Если в периметре **нет git / нет интернета** — заливаете tarball или rsync:

```bash
# с вашего ПК (из корня репо), после VPN
rsync -avz --exclude node_modules --exclude .env --exclude server/data/inbox \
  ./ auditor-deploy@vm1-app:/opt/auditor/

ssh auditor-deploy@vm1-app 'cd /opt/auditor && npm ci && npm run build && cd server && npm ci && sudo systemctl restart auditor-api'
```

`.env` **не перезаписываем** — только на сервере.

---

## Вариант C — Docker Compose

```bash
ssh auditor-deploy@vm1-app 'cd /opt/auditor && git pull && npm run build && docker compose -f deploy/docker-compose.yml up -d --build'
```

Миграции после обновления:

```bash
ssh auditor-deploy@vm1-app 'cd /opt/auditor && docker compose -f deploy/docker-compose.yml exec -T api node migrate_db.js'
```

---

## SSH config на вашем ПК (~/.ssh/config)

```sshconfig
Host auditor-pilot
    HostName vm1-app.corp.local
    User auditor-deploy
    ProxyJump jump.corp.local
    IdentityFile ~/.ssh/auditor_pilot_ed25519
```

Дальше:

```bash
ssh auditor-pilot
# или
./deploy/deploy-remote.sh auditor-pilot
```

---

## Что правим часто vs что не трогаем

| Меняем при каждом деплое | Не трогаем без нужды |
|--------------------------|----------------------|
| `server/`, `src/`, `dist/` | `.env` (только осознанно) |
| npm dependencies | `AUDITOR_INBOX_ROOT`, данные inbox |
| миграции БД | пароли Postgres prod |

---

## Чеклист «первый деплой на пилот»

1. [ ] VPN + SSH работает
2. [ ] `.env` на сервере из `deploy/.env.production.balanced.example`
3. [ ] `LLM_BASE_URL` → их Ollama, smoke `curl` с VM1
4. [ ] `migrate_db.js` один раз
5. [ ] nginx/TLS — они или мы
6. [ ] `curl https://auditor.../ping`

---

## Что сказать DevOps на встрече

> «На пилот нужен **VPN + SSH на VM приложения** под учёткой deploy с нашим **публичным ключом**. Мы будем часто обновлять код — git pull или rsync, рестарт сервиса. К GPU-VM SSH нужен только на установку Ollama; дальше ходим в LLM по HTTP из приложения.»

---

## Безопасность (их ИБ успокоит)

- Только **ваш** pubkey, без пароля по SSH
- Учётка **только** на VM пилота, не доменная admin
- Доступ **временный**, дата отзыва в протоколе
- `.env` и ключи **не в git**
- Логи действий — по их регламенту (журнал sudo)

---

*Версия: 1. Пилот / v1 внедрение*
