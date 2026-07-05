#!/usr/bin/env bash
set -u
UNIT="pi-remote@bixby.service"
URL="http://127.0.0.1:3141/healthz"
[ "$(systemctl is-active "$UNIT")" = active ] || exit 0
for _ in 1 2 3; do
  curl -fsS -m 5 "$URL" >/dev/null 2>&1 && exit 0
  sleep 4
done
logger -t pi-remote-health "healthz failed 3x on active $UNIT — restarting"
systemctl restart "$UNIT"
