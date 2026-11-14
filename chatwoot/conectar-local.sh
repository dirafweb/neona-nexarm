#!/usr/bin/env bash
# Crea en el Chatwoot local la cuenta, la bandeja de pruebas y el webhook hacia Nexarm.
# Uso: bash conectar-local.sh <correo de la persona administradora>
# Deja los datos de conexion en ../nexarm/.chatwoot.local.json (incluye la clave: no compartir).
set -euo pipefail
email="${1:?uso: bash conectar-local.sh <correo>}"
src="$(cd "$(dirname "$0")" && pwd)"
win_ip="$(ip route show default | awk '{print $3}')"
docker cp "$src/conectar-local.rb" chatwoot-rails-1:/tmp/conectar-local.rb
docker exec -e CW_ADMIN_EMAIL="$email" -e CW_WEBHOOK_URL="http://$win_ip:8787/chatwoot/webhook" \
  chatwoot-rails-1 bundle exec rails runner /tmp/conectar-local.rb
out="$src/../nexarm/.chatwoot.local.json"
docker cp chatwoot-rails-1:/tmp/nexarm-conexion.json /tmp/nexarm-conexion.json
# La clave de entrada solo se genera la primera vez: se conserva la que ya estaba guardada.
python3 - "$out" <<'PY'
import json, os, sys
new = json.load(open("/tmp/nexarm-conexion.json"))
if os.path.exists(sys.argv[1]):
    old = json.load(open(sys.argv[1]))
    new.setdefault("admin_password", old.get("admin_password"))
json.dump(new, open(sys.argv[1], "w"), indent=2)
PY
rm -f /tmp/nexarm-conexion.json
docker exec chatwoot-rails-1 rm -f /tmp/nexarm-conexion.json /tmp/conectar-local.rb
echo "windows_ip=$win_ip"
