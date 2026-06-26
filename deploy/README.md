# Развёртывание «ИИ-Аудитор» в периметре заказчика

On-prem, Linux, PostgreSQL, Ollama на GPU. Два варианта: **systemd + nginx** (рекомендуется) или **Docker Compose**.

Документы для встречи с DevOps: [docs/vnedrenie-v1/devops-meeting](../docs/vnedrenie-v1/devops-meeting/00-paket-na-vstrechu.md)

---

## Требования

| Компонент | Версия |
|-----------|--------|
| Node.js | 20.x или 22.x LTS |
| PostgreSQL | 14+ |
| Python | 3.10+ + `openpyxl` (`pip install -r requirements.txt`) |
| nginx | reverse proxy, TLS |
| Ollama | **Мощный:** `gemma3:27b` + `qwen2.5vl:32b` (GPU 48 GB). **Базовый:** `qwen2.5:7b` + `qwen2-vl:7b` (16 GB) |

Vision (компьютерное зрение): сканы PDF и фото → см. [docs/vnedrenie-v1/devops-meeting/04-kompyuternoe-zrenie.md](../docs/vnedrenie-v1/devops-meeting/04-kompyuternoe-zrenie.md).

---

## Вариант A — systemd + nginx (bare metal)

### 1. Подготовка каталога

```bash
sudo useradd -r -m -d /opt/auditor auditor || true
sudo mkdir -p /opt/auditor /var/lib/auditor/inbox
sudo chown -R auditor:auditor /opt/auditor /var/lib/auditor
```

### 2. Код и зависимости

```bash
cd /opt/auditor
git clone <repo-url> .   # или rsync релиза
npm ci && npm run build
cd server && npm ci && cd ..
pip3 install -r requirements.txt
```

### 3. Конфигурация

```bash
cp deploy/.env.production.power.example /opt/auditor/.env   # мощный: Gemma 27B + Qwen2.5-VL 32B
# или: cp deploy/.env.production.example /opt/auditor/.env  # базовый 7b
# отредактировать: DB_*, LLM_BASE_URL, пароли
node server/scripts/ensure_db.js
node server/migrate_db.js
```

### 4. systemd

```bash
sudo cp deploy/systemd/auditor-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable auditor-api
sudo systemctl start auditor-api
curl http://127.0.0.1:3001/ping
```

### 5. nginx

```bash
# отредактировать server_name и пути SSL в deploy/nginx/auditor.conf
sudo cp deploy/nginx/auditor.conf /etc/nginx/sites-available/auditor.conf
sudo ln -sf /etc/nginx/sites-available/auditor.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Frontend в prod использует **same-origin** `/api` (см. `src/apiBase.js`) — отдельный порт :3001 снаружи не нужен.

---

## Вариант B — Docker Compose

```bash
cp deploy/.env.production.example .env
# DB_HOST=postgres в .env для compose
npm ci && npm run build    # dist/ для nginx volume
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec api node migrate_db.js
curl http://localhost:8080/ping
```

Ollama **не входит** в compose — поднимается на GPU-VM отдельно. В `.env` указать `LLM_BASE_URL=http://<gpu-host>:11434/v1`.

---

## Ollama (GPU-VM)

Процедура offline/air-gap: [docs/vnedrenie-v1/devops-meeting/03-ollama-offline.md](../docs/vnedrenie-v1/devops-meeting/03-ollama-offline.md)

---

## Smoke test после установки

```bash
curl -k https://auditor.corp.local/ping
curl -k -X POST https://auditor.corp.local/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"...","password":"..."}'
```

---

## Файлы в этом каталоге

| Файл | Назначение |
|------|------------|
| `nginx/auditor.conf` | nginx HTTPS + SPA + proxy |
| `nginx/auditor-docker.conf` | nginx для docker-compose |
| `systemd/auditor-api.service` | unit-файл API |
| `.env.production.example` | шаблон prod env |
| `Dockerfile` | образ API + python probe |
| `docker-compose.yml` | postgres + api + nginx |
