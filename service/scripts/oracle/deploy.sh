#!/usr/bin/env bash
# Deploy service/ to the triage0-inference box. Usage: deploy.sh <public-ip> [BACKEND] [MODEL]
set -euo pipefail
IP="${1:?public ip}"; BACKEND="${2:-llamacpp}"; MODEL="${3:-medpsy-4b}"
KEY="${KEY:-$HOME/.ssh/triage0_oci}"
HOST="${HOST:-$(tr . - <<<"$IP").sslip.io}"
HERE="$(cd "$(dirname "$0")" && pwd)"; SVC="$(cd "$HERE/../.." && pwd)"
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$IP")

echo "host: https://$HOST  backend=$BACKEND model=$MODEL" >&2
"${SSH[@]}" 'sudo mkdir -p /opt/triage0/service /opt/triage0/models && sudo chown -R ubuntu:ubuntu /opt/triage0'
rsync -az --delete -e "ssh -i $KEY" \
  --exclude node_modules --exclude .models --exclude tests --exclude 'bench/results-*' \
  "$SVC/" "ubuntu@$IP:/opt/triage0/service/"
rsync -az -e "ssh -i $KEY" "$SVC/../package.json" "ubuntu@$IP:/opt/triage0/package.json"

sed "s/__HOST__/$HOST/" "$HERE/Caddyfile" | "${SSH[@]}" 'cat > /tmp/Caddyfile'
case "$MODEL" in medpsy-4b) MF=medpsy-4b-q4_k_m-imat.gguf;; medpsy-1.7b) MF=medpsy-1.7b-q4_k_m-imat.gguf;; *) echo "bad model" >&2; exit 1;; esac
"${SSH[@]}" "sudo bash -s" <<REMOTE
set -euo pipefail
cd /opt/triage0 && npm install --omit=dev --workspaces --include-workspace-root --no-audit --no-fund >/tmp/npm-install.log 2>&1 || { tail -20 /tmp/npm-install.log; exit 1; }
chown -R triage0:triage0 /opt/triage0
install -m 600 -o root -g root /dev/stdin /etc/triage0.env <<ENV
CORS_ORIGINS=https://$HOST
BACKEND=$BACKEND
MODEL=$MODEL
MODEL_DIR=/opt/triage0/models
PORT=3020
LLAMA_SERVER_URL=http://127.0.0.1:8081
LLAMA_MODEL_FILE=$MF
ENV
install -m 644 /opt/triage0/service/scripts/oracle/triage0.service /etc/systemd/system/
install -m 644 /opt/triage0/service/scripts/oracle/llama-server.service /etc/systemd/system/
install -m 644 /tmp/Caddyfile /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable triage0 llama-server caddy >/dev/null
systemctl restart caddy
systemctl restart llama-server || true
systemctl restart triage0
sleep 3
systemctl --no-pager --lines=0 status triage0 llama-server caddy | grep -E "●|Active:"
REMOTE
echo "https://$HOST" 
