#!/usr/bin/env bash
# Instala Chatwoot en esta PC (Ubuntu de WSL con Docker). Uso: bash instalar-local.sh
# Queda en http://localhost:3010. Los secretos se guardan dentro de Ubuntu, en ~/chatwoot/.env.local.
set -euo pipefail

src="$(cd "$(dirname "$0")" && pwd)"
dir="$HOME/chatwoot"
mkdir -p "$dir"
cp "$src/docker-compose.local.yaml" "$dir/docker-compose.yaml"
cd "$dir"

if [ ! -f .env.local ]; then
  umask 077
  cat > .env.local <<EOF
FRONTEND_URL=http://localhost:3010
SECRET_KEY_BASE=$(openssl rand -hex 64)
POSTGRES_HOST=postgres
POSTGRES_USERNAME=postgres
POSTGRES_PASSWORD=$(openssl rand -hex 24)
REDIS_URL=redis://redis:6379
REDIS_PASSWORD=$(openssl rand -hex 24)
RAILS_ENV=production
RAILS_LOG_TO_STDOUT=true
LOG_LEVEL=info
DEFAULT_LOCALE=es
ENABLE_ACCOUNT_SIGNUP=false
FORCE_SSL=false
ACTIVE_STORAGE_SERVICE=local
EOF
fi

docker compose --env-file .env.local pull -q
docker compose --env-file .env.local run --rm rails bundle exec rails db:chatwoot_prepare
docker compose --env-file .env.local up -d
echo "Chatwoot arranca en http://localhost:3010"
