#!/usr/bin/env bash
# Instala Chatwoot en un servidor Ubuntu con Docker. Uso: bash instalar.sh chat.midominio.com
# El dominio debe apuntar ya a la IP de este servidor, con los puertos 80 y 443 abiertos.
set -euo pipefail

domain="${1:?uso: bash instalar.sh <dominio>}"
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  umask 077
  cat > .env <<EOF
CHATWOOT_DOMAIN=$domain
FRONTEND_URL=https://$domain
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
FORCE_SSL=true
ACTIVE_STORAGE_SERVICE=local
EOF
  echo "Secretos generados en $(pwd)/.env"
fi

docker compose pull
docker compose run --rm rails bundle exec rails db:chatwoot_prepare
docker compose up -d
echo "Chatwoot arranca en https://$domain (el certificado tarda cerca de un minuto). Crea ahi la cuenta de administracion."
