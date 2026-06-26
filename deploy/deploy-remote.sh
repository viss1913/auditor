#!/usr/bin/env bash
# Деплой на удалённый пилот-стенд по SSH.
# Использование:
#   ./deploy/deploy-remote.sh auditor-pilot              # git pull + build + systemd
#   ./deploy/deploy-remote.sh auditor-pilot --docker   # docker compose
#   ./deploy/deploy-remote.sh user@host --rsync        # rsync с локальной машины
set -euo pipefail

HOST="${1:?Usage: $0 user@host|ssh-alias [--docker|--rsync]}"
MODE="${2:-systemd}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

remote() { ssh "$HOST" "$@"; }

case "$MODE" in
  --docker)
    if [[ "$2" == "--rsync" ]]; then
      echo "Use --rsync or --docker, not both"
      exit 1
    fi
    remote "cd /opt/auditor && git pull && npm ci && npm run build && docker compose -f deploy/docker-compose.yml up -d --build"
    remote "cd /opt/auditor && docker compose -f deploy/docker-compose.yml exec -T api node migrate_db.js"
    remote "curl -sf http://127.0.0.1:8080/ping || curl -sf http://127.0.0.1:3001/ping"
    ;;
  --rsync)
    rsync -avz --delete \
      --exclude node_modules --exclude server/node_modules \
      --exclude .env --exclude dist \
      --exclude 'server/data/inbox' --exclude server/uploads \
      "$ROOT/" "$HOST:/opt/auditor/"
    remote "cd /opt/auditor && npm ci && npm run build && cd server && npm ci"
    remote "sudo systemctl restart auditor-api"
    remote "curl -sf http://127.0.0.1:3001/ping"
    ;;
  *)
    remote "cd /opt/auditor && git pull && npm ci && npm run build && cd server && npm ci && cd .."
    remote "node /opt/auditor/server/migrate_db.js || true"
    remote "sudo systemctl restart auditor-api"
    remote "curl -sf http://127.0.0.1:3001/ping"
    ;;
esac

echo "OK: deploy to $HOST ($MODE)"
