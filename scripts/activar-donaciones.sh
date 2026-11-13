#!/bin/zsh
# Abre las donaciones: guarda el Access Token de Mercado Pago del titular como secreto del Worker.
#   0. Opcional: exporta NA_PREVIEW_URL con la URL de tu preview de workers.dev para la comprobación final.
#   1. mercadopago.com.mx/developers → tu aplicación → Credenciales de producción.
#   2. Copia el Access Token (queda en el portapapeles; este script nunca lo muestra ni lo guarda en disco).
#   3. Corre:  zsh ~/NetworkAlert/scripts/activar-donaciones.sh            ← producción (networkalert.dev)
#              zsh ~/NetworkAlert/scripts/activar-donaciones.sh preview    ← el preview de workers.dev
# OJO: con el token de producción los cobros son reales también en el preview.
set -e
cd "$(dirname "$0")/.."
TOKEN="$(pbpaste | tr -d '[:space:]')"
[[ "$TOKEN" =~ ^APP_USR-[0-9]+-[A-Za-z0-9-]+$ ]] || { echo "El portapapeles no trae un Access Token de producción (APP_USR-<números>-…). Cópialo y vuelve a correr."; exit 1; }
if [[ "$1" == "ambos" ]]; then   # preview y, además, el secreto listo para producción (no despliega nada)
  printf '%s' "$TOKEN" | npx wrangler secret put MP_ACCESS_TOKEN --env preview >/dev/null
  printf '%s' "$TOKEN" | npx wrangler secret put MP_ACCESS_TOKEN >/dev/null 2>&1 && echo "Secreto de producción: guardado" || echo "Secreto de producción: no se pudo (el Worker aún no existe); repite tras el primer despliegue"
  URL="${NA_PREVIEW_URL:-}"
elif [[ "$1" == "preview" ]]; then
  printf '%s' "$TOKEN" | npx wrangler secret put MP_ACCESS_TOKEN --env preview >/dev/null
  URL="${NA_PREVIEW_URL:-}"
else
  printf '%s' "$TOKEN" | npx wrangler secret put MP_ACCESS_TOKEN >/dev/null
  URL="https://networkalert.dev"
fi
printf '' | pbcopy
sleep 3
echo "Portapapeles limpio."
[[ -n "$URL" ]] && echo "Estado: $(curl -s $URL/api/donar/estado)"
