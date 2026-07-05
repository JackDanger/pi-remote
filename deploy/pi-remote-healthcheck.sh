#!/usr/bin/env bash
set -u
UNIT="pi-remote@bixby.service"
URL="http://127.0.0.1:3141/healthz"
state="$(systemctl is-active "$UNIT")"
if [ "$state" != active ]; then
  logger -t pi-remote-health "$UNIT is $state — starting"
  systemctl restart "$UNIT"
  exit 0
fi
for _ in 1 2 3; do
  curl -fsS -m 5 "$URL" >/dev/null 2>&1 && exit 0
  sleep 4
done
logger -t pi-remote-health "healthz failed 3x on active $UNIT — restarting"
systemctl restart "$UNIT"
