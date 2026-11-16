#!/usr/bin/env bash
#
# Deployt die ADS-B-Webapp (PWA) nach https://adsb.wetterheidi.de
#
# - Testet und baut dist/ (bun test, bun run build; dist/sw.js ist der
#   Service Worker für den Offline-Betrieb, siehe vite.config.ts).
# - Sichert vorher den aktuellen Stand nach /apps/adsb.prev,
#   zurück mit: bun run rollback
# - Fehlt der nginx-Vhost, wird er angelegt (mit Pförtner-Gate, tool=adsb,
#   abschaltbar über PFOERTNER=nein unten) und das Let's-Encrypt-Zertifikat
#   geholt. Ein vorhandener Vhost wird nicht angefasst.
# - Synchronisiert dist/ nach /apps/adsb auf dem Server (--delete: dort
#   liegt danach genau der neue Build).
#
# Voraussetzung: DNS-Eintrag für $DOMAIN zeigt auf den Server, SSH-Zugang
# als root per Schlüssel. Details: docs/PWA.md
#
# Aufruf: cd webapp && bun run deploy

set -euo pipefail

SERVER="root@178.104.206.136"
DOMAIN="adsb.wetterheidi.de"
TOOL="adsb"
PFOERTNER="ja"          # "nein" = Seite ohne Login öffentlich erreichbar
REMOTE_DIR="/apps/adsb"
VHOST="/etc/nginx/sites-available/$DOMAIN"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$PROJECT_DIR"
bun install --frozen-lockfile
bun test
bun run build

echo "==> Sichere aktuellen Stand nach $REMOTE_DIR.prev ..."
ssh "$SERVER" "mkdir -p '$REMOTE_DIR' && rsync -a --delete '$REMOTE_DIR/' '$REMOTE_DIR.prev/'"

echo "==> Prüfe nginx-Vhost ..."
ssh "$SERVER" bash -s -- "$VHOST" "$REMOTE_DIR" "$DOMAIN" "$TOOL" "$PFOERTNER" <<'REMOTE'
set -euo pipefail
VHOST="$1"
REMOTE_DIR="$2"
DOMAIN="$3"
TOOL="$4"
PFOERTNER="$5"

if [ -f "$VHOST" ]; then
    echo "    Vhost existiert bereits, bleibt unverändert."
    exit 0
fi

GATE=""
if [ "$PFOERTNER" = "ja" ]; then
    GATE="
    # --- Pfoertner: gilt für den gesamten Vhost -----------------------------
    set \$pfoertner_tool $TOOL;
    auth_request /_pfoertner;
    error_page 401 = @zum_login;
    error_page 403 /gesperrt.html;
    include snippets/pfoertner.conf;
    # ------------------------------------------------------------------------

    # Let's-Encrypt-Validierung muss ohne Login erreichbar sein.
    location ^~ /.well-known/acme-challenge/ {
        auth_request off;
    }
"
fi

echo "    Lege nginx-Vhost für $DOMAIN an (Pförtner: $PFOERTNER) ..."
cat > "$VHOST" <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    root $REMOTE_DIR;
    index index.html;
$GATE
    # PWA: Service Worker und Startseite immer frisch vom Server holen,
    # damit ein neuer Deploy beim nächsten Online-Start ankommt.
    location = /sw.js {
        add_header Cache-Control "no-cache";
        try_files \$uri =404;
    }
    location = /index.html {
        add_header Cache-Control "no-cache";
    }
    # Ältere nginx-mime.types kennen .webmanifest nicht.
    location ~ \.webmanifest\$ {
        default_type application/manifest+json;
        try_files \$uri =404;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
NGINX
ln -sf "$VHOST" "/etc/nginx/sites-enabled/$DOMAIN"
if ! nginx -t; then
    echo "    nginx -t fehlgeschlagen, entferne neuen Vhost wieder." >&2
    rm -f "/etc/nginx/sites-enabled/$DOMAIN" "$VHOST"
    exit 1
fi
systemctl reload nginx

echo "    Hole Let's-Encrypt-Zertifikat ..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect
REMOTE

echo "==> Synchronisiere dist/ nach $SERVER:$REMOTE_DIR ..."
rsync -avz --delete --exclude=.DS_Store "$PROJECT_DIR/dist/" "$SERVER:$REMOTE_DIR/"
ssh "$SERVER" chown -R www-data:www-data "$REMOTE_DIR"

echo "==> Fertig: https://$DOMAIN"
