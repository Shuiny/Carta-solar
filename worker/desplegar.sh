#!/bin/sh
# Despliega el worker de cartasolar.com en la cuenta de Cloudflare con la que inicies sesión
# y apunta index.html a él. Se puede correr las veces que quieras.
#   ./worker/desplegar.sh            (desde la carpeta del repo)
set -eu
cd "$(dirname "$0")"
W="npx --yes wrangler@4.45.0"
CONF="$HOME/.config/cartasolar"
mkdir -p "$CONF"; chmod 700 "$CONF"

$W whoami 2>/dev/null | grep -q "associated with" || $W login

# 1. KV de estaciones (solo la primera vez)
if grep -q PON_AQUI_EL_ID wrangler.toml; then
  ID=$($W kv namespace create DATOS 2>&1 | grep -oE '[0-9a-f]{32}' | head -1)
  [ -n "$ID" ] || { echo "No se pudo crear el KV"; exit 1; }
  sed -i "s/PON_AQUI_EL_ID/$ID/" wrangler.toml
fi

# 2. Desplegar y guardar la URL
URL=$($W deploy 2>&1 | tee /dev/stderr | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -n "$URL" ] || { echo "No salió la URL del worker"; exit 1; }
echo "$URL" > "$CONF/api"

# 3. Clave de administración (se genera una vez y queda solo en tu máquina)
if [ ! -s "$CONF/clave" ]; then
  python3 -c "import secrets;print(secrets.token_urlsafe(32))" > "$CONF/clave"
  chmod 600 "$CONF/clave"
  $W secret put CLAVE < "$CONF/clave"
fi

# 4. La página usa el worker nuevo
sed -i -E "s#l=\"https://[a-z0-9.-]+\.workers\.dev/\?u=\",u=\"https://[a-z0-9.-]+\.workers\.dev\"#l=\"$URL/?u=\",u=\"$URL\"#" ../index.html
grep -q "l=\"$URL/?u=\",u=\"$URL\"" ../index.html && echo "index.html apunta a $URL"
