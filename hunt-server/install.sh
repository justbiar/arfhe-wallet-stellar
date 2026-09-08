#!/usr/bin/env bash
#
# Puts the hunt server on a fresh VPS. Run as root from inside this directory.
#
# Deliberately stops before starting anything: fragments.json holds the phrase and must be
# filled in by a person, and a server that came up serving empty fragments would look
# healthy while handing every finder nothing.

set -euo pipefail

TARGET=/opt/arfhe-hunt
SERVICE_USER=arfhe-hunt

echo "→ user"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "→ files"
mkdir -p "$TARGET"
cp server.mjs package.json "$TARGET/"
[ -f "$TARGET/.env" ] || cp .env.example "$TARGET/.env"
[ -f "$TARGET/fragments.json" ] || cp fragments.example.json "$TARGET/fragments.json"

echo "→ dependencies"
cd "$TARGET"
npm install ethers --omit=dev --no-audit --no-fund

echo "→ permissions"
# The words are in here. Nothing outside the service account needs to read them.
chown -R "$SERVICE_USER":"$SERVICE_USER" "$TARGET"
chmod 700 "$TARGET"
chmod 600 "$TARGET/.env" "$TARGET/fragments.json"

echo "→ service"
cd - >/dev/null
cp arfhe-hunt.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable arfhe-hunt

cat <<'NEXT'

Installed, not started. Two files need a person before it is worth running:

  /opt/arfhe-hunt/.env             RPC URLs and the extension origin
  /opt/arfhe-hunt/fragments.json   the twelve words

Then:

  systemctl start arfhe-hunt
  systemctl status arfhe-hunt
  curl -X POST http://127.0.0.1:8787/hunt/nonce     # expect a nonce

And add nginx-snippet.conf to the mcp.arfhewallet.dev server block.

NEXT
