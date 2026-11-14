#!/usr/bin/env bash
# Launch the triage0-inference Ampere A1 instance. Idempotent on the NSG; retries on
# "Out of host capacity" (600 s) and 429 TooManyRequests (180 s), up to 36 times. Never touches coldspot-web or leash-rescue.
set -euo pipefail

C="${COMPARTMENT:-ocid1.compartment.oc1..aaaaaaaavz5bytndqzcbof7a5kltsolmg5dbmtue5xzkiil3ihjxcahzaueq}"  # triage0-catcher compartment (own VCN; scoped key)
AD="ABHv:CA-TORONTO-1-AD-1"
VCN="${VCN:-ocid1.vcn.oc1.ca-toronto-1.amaaaaaavfi4whqaeahffkvgicfgfzcwlgrlijwgsbsuefpkzkssftybvcgq}"
PUBLIC_SUBNET="${SUBNET:-ocid1.subnet.oc1.ca-toronto-1.aaaaaaaa2kwd3f3bqosy5ygbojekfduoixracjxz4e47uy7h7qlxxpai475q}"
IMAGE="ocid1.image.oc1.ca-toronto-1.aaaaaaaatrshr4z7fif4wr72yo3gbmq4ftblwrgkwrp76geijzdauhldqkva"
NAME="triage0-inference"
OCPUS="${OCPUS:-2}"
MEM_GB="${MEM_GB:-12}"
KEY_PUB="${KEY_PUB:-$HOME/.ssh/triage0_oci.pub}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAX_TRIES="${MAX_TRIES:-36}"
SLEEP_S="${SLEEP_S:-600}"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

existing=$(oci compute instance list --compartment-id "$C" \
  --query "data[?\"display-name\"=='$NAME' && \"lifecycle-state\"!='TERMINATED'].id | [0]" --raw-output 2>/dev/null || true)
if [[ -n "$existing" && "$existing" != "null" ]]; then
  log "instance $NAME already exists: $existing"; echo "$existing"; exit 0
fi

NSG=$(oci network nsg list --compartment-id "$C" --vcn-id "$VCN" \
  --query "data[?\"display-name\"=='triage0-nsg'].id | [0]" --raw-output)
if [[ -z "$NSG" || "$NSG" == "null" ]]; then
  log "creating NSG triage0-nsg"
  NSG=$(oci network nsg create --compartment-id "$C" --vcn-id "$VCN" --display-name triage0-nsg \
    --freeform-tags '{"project":"triage-0"}' --query data.id --raw-output)
  rules='['
  for p in 22 80 443; do
    rules+="{\"direction\":\"INGRESS\",\"protocol\":\"6\",\"source\":\"0.0.0.0/0\",\"sourceType\":\"CIDR_BLOCK\",\"tcpOptions\":{\"destinationPortRange\":{\"min\":$p,\"max\":$p}}},"
  done
  rules+='{"direction":"EGRESS","protocol":"all","destination":"0.0.0.0/0","destinationType":"CIDR_BLOCK"}]'
  oci network nsg rules add --nsg-id "$NSG" --security-rules "$rules" >/dev/null
fi
log "NSG: $NSG"

for ((i = 1; i <= MAX_TRIES; i++)); do
  log "launch attempt $i/$MAX_TRIES ($OCPUS OCPU / $MEM_GB GB)"
  set +e
  out=$(oci compute instance launch \
    --compartment-id "$C" --availability-domain "$AD" \
    --shape VM.Standard.A1.Flex --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM_GB}" \
    --image-id "$IMAGE" --subnet-id "$PUBLIC_SUBNET" --nsg-ids "[\"$NSG\"]" \
    --assign-public-ip true --display-name "$NAME" \
    --boot-volume-size-in-gbs 50 \
    --ssh-authorized-keys-file "$KEY_PUB" \
    --user-data-file "$HERE/cloud-init.yaml" \
    --freeform-tags '{"project":"triage-0"}' \
    --wait-for-state RUNNING --wait-for-state TERMINATED 2>&1)
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    id=$(printf '%s' "$out" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
    log "RUNNING: $id"
    echo "$id"
    exit 0
  fi
  if grep -q "Out of host capacity" <<<"$out"; then
    log "out of host capacity; sleeping ${SLEEP_S}s"
    sleep "$SLEEP_S"
    continue
  fi
  if grep -q "TooManyRequests" <<<"$out"; then
    # Free Tier A1 launches are throttled with 429 when the region is tight; same remedy, shorter wait.
    log "429 TooManyRequests; sleeping ${SLEEP_429_S:-180}s"
    sleep "${SLEEP_429_S:-180}"
    continue
  fi
  if grep -qiE "timed out|Connection aborted|ConnectionError|Max retries|ServiceUnavailable|Service unavailable|Temporary failure|Name or service not known" <<<"$out"; then
    # Transient network / service error: not a verdict on capacity. Short wait, same attempt budget.
    log "transient error (network/service); sleeping ${SLEEP_NET_S:-120}s"; printf '%s\n' "$out" | grep -m1 '"message"' >&2 || true
    sleep "${SLEEP_NET_S:-120}"
    i=$((i - 1))   # a network blip is not an attempt; do not spend the budget on it
    continue
  fi
  log "launch failed:"; printf '%s\n' "$out" >&2
  exit "$rc"
done
log "gave up after $MAX_TRIES attempts"
exit 2
