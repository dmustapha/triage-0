#!/usr/bin/env bash
# One attempt to launch the Triage-0 Ampere A1 instance inside the scoped catcher compartment.
# Exit 0 = instance exists/launched or capacity unavailable (try again next tick); exit 1 = real error.
set -euo pipefail
: "${OCI_COMPARTMENT_OCID:?}" "${OCI_SUBNET_OCID:?}" "${OCI_NSG_OCID:?}"
AD="ABHv:CA-TORONTO-1-AD-1"
IMAGE="ocid1.image.oc1.ca-toronto-1.aaaaaaaatrshr4z7fif4wr72yo3gbmq4ftblwrgkwrp76geijzdauhldqkva"
NAME="triage0-inference"
OCPUS="${OCPUS:-1}"; MEM_GB="${MEM_GB:-6}"
HERE="$(cd "$(dirname "$0")" && pwd)"

existing=$(oci compute instance list --compartment-id "$OCI_COMPARTMENT_OCID" \
  --query "data[?\"display-name\"=='$NAME' && \"lifecycle-state\"!='TERMINATED'].id | [0]" --raw-output 2>/dev/null || true)
if [[ -n "$existing" && "$existing" != "null" ]]; then
  echo "::notice::instance already exists"; echo "EXISTS=1" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0
fi

set +e
out=$(oci compute instance launch \
  --compartment-id "$OCI_COMPARTMENT_OCID" --availability-domain "$AD" \
  --shape VM.Standard.A1.Flex --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEM_GB}" \
  --image-id "$IMAGE" --subnet-id "$OCI_SUBNET_OCID" --nsg-ids "[\"$OCI_NSG_OCID\"]" \
  --assign-public-ip true --display-name "$NAME" --boot-volume-size-in-gbs 50 \
  --ssh-authorized-keys-file "$HERE/triage0_oci.pub" \
  --user-data-file "$HERE/cloud-init.yaml" \
  --freeform-tags '{"project":"triage-0"}' 2>&1)
rc=$?
set -e
if [[ $rc -eq 0 ]]; then
  echo "::notice::LAUNCHED"; echo "LAUNCHED=1" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 0
fi
if grep -qE "Out of host capacity|TooManyRequests|timed out|ServiceUnavailable" <<<"$out"; then
  echo "no capacity this tick ($(grep -oE 'Out of host capacity|TooManyRequests|timed out|ServiceUnavailable' <<<"$out" | head -1))"; exit 0
fi
echo "::error::launch failed"; grep -E '"code"|"message"' <<<"$out" | head -2; exit 1
