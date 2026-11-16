#!/usr/bin/env bash
#
# Setzt https://adsb.wetterheidi.de auf den Stand vor dem letzten Deploy
# zurück (Sicherung in /apps/adsb.prev, angelegt von deploy-hetzner.sh).
# Installierte PWAs holen sich den alten Stand beim nächsten Online-Start
# wie ein normales Update.
#
# Aufruf: cd webapp && bun run rollback

set -euo pipefail

SERVER="root@178.104.206.136"
DOMAIN="adsb.wetterheidi.de"
REMOTE_DIR="/apps/adsb"

ssh "$SERVER" bash -s -- "$REMOTE_DIR" <<'REMOTE'
set -euo pipefail
REMOTE_DIR="$1"
if [ ! -d "$REMOTE_DIR.prev" ]; then
    echo "Keine Sicherung $REMOTE_DIR.prev vorhanden." >&2
    exit 1
fi
echo "==> Stelle $REMOTE_DIR aus $REMOTE_DIR.prev wieder her ..."
rsync -a --delete "$REMOTE_DIR.prev/" "$REMOTE_DIR/"
chown -R www-data:www-data "$REMOTE_DIR"
REMOTE

echo "==> Zurückgesetzt: https://$DOMAIN"
