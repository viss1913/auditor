#!/usr/bin/env bash
# Первичная установка на Immers GPU-сервер (Ubuntu, один хост: app + PG + Ollama localhost)
set -euo pipefail

AUDITOR_DB_PASS="${AUDITOR_DB_PASS:-$(openssl rand -hex 16)}"
DEMO_PASS="${DEMO_PASS:-Auditor2026!}"
DEMO_TOKEN="${DEMO_TOKEN:-$(openssl rand -hex 24)}"

echo "==> Пакеты (Node 22, PostgreSQL, nginx, python)..."
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq curl ca-certificates gnupg nginx postgresql postgresql-contrib python3-pip python3-venv

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

sudo pip3 install --break-system-packages -q 'openpyxl>=3.1.2,<4' 2>/dev/null \
  || sudo pip3 install -q 'openpyxl>=3.1.2,<4'

echo "==> Пользователь и каталоги..."
sudo useradd -r -m -d /opt/auditor auditor 2>/dev/null || true
sudo mkdir -p /opt/auditor /var/lib/auditor/inbox
sudo chown -R auditor:auditor /opt/auditor /var/lib/auditor

echo "==> PostgreSQL..."
sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='auditor'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE USER auditor WITH PASSWORD '${AUDITOR_DB_PASS}';"
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='auditor'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE auditor OWNER auditor;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE auditor TO auditor;"

echo "==> .env..."
sudo tee /opt/auditor/.env >/dev/null <<EOF
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=auditor
DB_USER=auditor
DB_PASSWORD=${AUDITOR_DB_PASS}

AUTH_STUB_ENABLED=1
DEMO_AUTH_EMAIL=admin@corp.local
DEMO_AUTH_PASSWORD=${DEMO_PASS}
DEMO_AUTH_TOKEN=${DEMO_TOKEN}

LLM_PROVIDER=openai
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5:7b-instruct
QWEN_MODEL=qwen2.5:7b-instruct
LLM_TIMEOUT_MS=180000
MARTIN_USE_LLM_AUTOSTART=1
MARTIN_SMART_DIALOG=1
MARTIN_USE_TOOLS=1
MARTIN_PARSE_TIMEOUT_MS=1800000

DOCUMENT_SCAN_ENABLED=1
VISION_LLM_BASE_URL=http://127.0.0.1:11434/v1
VISION_MODEL=qwen2.5vl:7b
VISION_TIMEOUT_MS=180000
DOCUMENT_SCAN_MIN_LINES=8
BROKER_PDF_VISION_ALWAYS=1

PYTHON_PATH=python3
EXCEL_PROBE_TIMEOUT_MS=180000
AUDITOR_INBOX_ROOT=/var/lib/auditor/inbox
EOF
sudo chown auditor:auditor /opt/auditor/.env
sudo chmod 600 /opt/auditor/.env

echo "==> SSL (self-signed для :443)..."
sudo mkdir -p /etc/ssl/private /etc/ssl/certs
if [[ ! -f /etc/ssl/certs/auditor.crt ]]; then
  sudo openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout /etc/ssl/private/auditor.key \
    -out /etc/ssl/certs/auditor.crt \
    -subj "/CN=audit-ai/O=Auditor/C=RU"
  sudo chmod 600 /etc/ssl/private/auditor.key
fi

echo "==> nginx..."
sudo tee /etc/nginx/sites-available/auditor.conf >/dev/null <<'NGINX'
upstream auditor_api {
    server 127.0.0.1:3001;
    keepalive 32;
}

server {
    listen 443 ssl;
    server_name _;

    ssl_certificate     /etc/ssl/certs/auditor.crt;
    ssl_certificate_key /etc/ssl/private/auditor.key;

    client_max_body_size 150m;

    root /opt/auditor/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://auditor_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
        proxy_connect_timeout 60s;
    }

    location ~ ^/(ping|upload|trades|audit)(/|$) {
        proxy_pass http://auditor_api;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 1800s;
        proxy_send_timeout 1800s;
    }
}
NGINX
sudo ln -sf /etc/nginx/sites-available/auditor.conf /etc/nginx/sites-enabled/auditor.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl enable nginx
sudo systemctl restart nginx

echo "==> systemd auditor-api..."
sudo cp /opt/auditor/deploy/systemd/auditor-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable auditor-api

echo ""
echo "=== DB password: ${AUDITOR_DB_PASS}"
echo "=== Login: admin@corp.local / ${DEMO_PASS}"
echo "=== Setup base OK (запустите upload+build отдельно) ==="
