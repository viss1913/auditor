#!/usr/bin/env bash
# Деплой на удалённый пилот-стенд по SSH.
# Использование:
#   ./deploy/deploy-remote.sh auditor-pilot              # git pull + build + systemd
#   ./deploy/deploy-remote.sh auditor-pilot --docker   # docker compose
#   ./deploy/deploy-remote.sh user@host --rsync        # rsync с локальной машины
#
# SPA на сервере: AUDITOR_WEB_DIR=/opt/auditor-web (git pull + build на VM).
# SPA локально (Immers): собрать ../auditor-web → dist/ rsync при отсутствии WEB_DIR на сервере.
set -euo pipefail

HOST="${1:?Usage: $0 user@host|ssh-alias [--docker|--rsync]}"
MODE="${2:-systemd}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="${AUDITOR_WEB_DIR:-/opt/auditor-web}"
LOCAL_WEB_DIR="${AUDITOR_WEB_LOCAL_DIR:-$ROOT/../auditor-web}"

remote() { ssh "$HOST" "$@"; }

run_migrate() {
  remote "cd /opt/auditor/server && node migrate_db.js"
}

sync_local_dist() {
  if [[ -d "$LOCAL_WEB_DIR/dist" ]]; then
    echo "Sync local SPA: $LOCAL_WEB_DIR/dist/ → $HOST:/opt/auditor/dist/"
    rsync -avz --delete "$LOCAL_WEB_DIR/dist/" "$HOST:/opt/auditor/dist/"
  else
    echo "WARN: no $WEB_DIR on server and no $LOCAL_WEB_DIR/dist — skip SPA (build auditor-web first)"
  fi
}

build_frontend() {
  if remote "[[ -d ${WEB_DIR} ]]"; then
    remote "cd ${WEB_DIR} && git pull && npm ci && npm run build && mkdir -p /opt/auditor/dist && rsync -a --delete dist/ /opt/auditor/dist/"
  else
    echo "WARN: ${WEB_DIR} not found on server"
    sync_local_dist
  fi
}

case "$MODE" in
  --docker)
    if [[ "$2" == "--rsync" ]]; then
      echo "Use --rsync or --docker, not both"
      exit 1
    fi
    build_frontend
    remote "cd /opt/auditor && git pull && docker compose -f deploy/docker-compose.yml up -d --build"
    remote "cd /opt/auditor && docker compose -f deploy/docker-compose.yml exec -T api node migrate_db.js"
    remote "curl -sf http://127.0.0.1:8080/ping || curl -sf http://127.0.0.1:3001/ping"
    ;;
  --rsync)
    rsync -avz --delete \
      --exclude node_modules --exclude server/node_modules \
      --exclude .env --exclude dist \
      --exclude 'server/data/inbox' --exclude server/uploads \
      "$ROOT/" "$HOST:/opt/auditor/"
    build_frontend
    remote "cd /opt/auditor/server && npm ci"
    run_migrate
    remote "sudo systemctl restart auditor-api"
    remote "curl -sf http://127.0.0.1:3001/ping"
    ;;
  *)
    remote "cd /opt/auditor && git pull && cd server && npm ci && cd .."
    build_frontend
    run_migrate
    remote "sudo systemctl restart auditor-api"
    remote "curl -sf http://127.0.0.1:3001/ping"
    ;;
esac

echo "OK: deploy to $HOST ($MODE)"
