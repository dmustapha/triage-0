# Oracle Cloud runbook: triage0-inference

**Rule one:** the tenancy also holds `coldspot-web` and `leash-rescue` (both `VM.Standard.E2.1.Micro`). They belong to other projects. Never stop, edit, or terminate them, and never edit the VCN's shared security lists. Everything for this project is addressed by OCID, never by name match.

## Facts (verified 2026-11-10)
| Item | Value |
|---|---|
| Tenancy / compartment | `ocid1.tenancy.oc1..aaaaaaaaoycde4gwm3c6qduk5n4xx5wz2i2qiiupg5yioxr7st2sly4a3jbq` |
| Region / AD | ca-toronto-1 / `ABHv:CA-TORONTO-1-AD-1` (only AD) |
| A1 limit | 2 OCPU / 12 GB (Free Tier; PAYG upgrade raises to 4 / 24) |
| Compartment | `triage0-catcher` `ocid1.compartment.oc1..aaaaaaaavz5bytndqzcbof7a5kltsolmg5dbmtue5xzkiil3ihjxcahzaueq` (everything Triage-0 lives here; the catcher key cannot see anything else) |
| VCN | `triage0-vcn` `ocid1.vcn.oc1.ca-toronto-1.amaaaaaavfi4whqaeahffkvgicfgfzcwlgrlijwgsbsuefpkzkssftybvcgq` (10.1.0.0/16, own IGW; the old shared VCN is no longer used) |
| Public subnet | `triage0-public` `ocid1.subnet.oc1.ca-toronto-1.aaaaaaaa2kwd3f3bqosy5ygbojekfduoixracjxz4e47uy7h7qlxxpai475q` (10.1.0.0/24) |
| Image | Canonical Ubuntu 24.04 aarch64, `ocid1.image.oc1.ca-toronto-1.aaaaaaaatrshr4z7fif4wr72yo3gbmq4ftblwrgkwrp76geijzdauhldqkva` |
| SSH key | `~/.ssh/triage0_oci` (ed25519, created 2026-11-10, never committed) |
| NSG | `triage0-nsg` `ocid1.networksecuritygroup.oc1.ca-toronto-1.aaaaaaaa4wkw7tlxtu3pzrtzyueq6a7jz5ozyhxbtoucus2736y2fn3hlflq`: ingress TCP 22/80/443, egress all |
| Instance | `triage0-inference`, `VM.Standard.A1.Flex` 2/12, 50 GB boot. OCID / IP: _filled by launch_ |
| Hostname | `<ip-with-dashes>.sslip.io` via Caddy until the real domain (Task 9) |

## Launch
```bash
service/scripts/oracle/launch.sh           # idempotent; retries "Out of host capacity" every 600 s, 36 times
OCPUS=4 MEM_GB=24 service/scripts/oracle/launch.sh   # after a PAYG upgrade
```

## Operate (this instance only, by OCID)
```bash
ID=<instance ocid>
oci compute instance action --instance-id "$ID" --action STOP
oci compute instance action --instance-id "$ID" --action START
oci compute instance terminate --instance-id "$ID" --preserve-boot-volume false   # asks for confirmation
ssh -i ~/.ssh/triage0_oci ubuntu@<ip>
```

## First-boot check
```bash
ssh -i ~/.ssh/triage0_oci ubuntu@<ip> 'uname -m; nproc; free -g | head -2; test -f /var/lib/cloud/triage0-ready && echo READY'
```
cloud-init builds llama.cpp from source, so READY takes 15 to 25 minutes.

## Cost guard
Everything here sits inside Always Free. Set a budget alert at $1 on the tenancy (Billing → Budgets) so any accidental paid resource pings before it grows.

## Scoped identity and the GitHub Actions catcher (2026-11-12)
- IAM user `triage0-catcher` (API key only, fingerprint `05:a4:…:02:d7`, private key at `~/.oci/triage0-catcher/key.pem` on the Mac and in repo secret `OCI_PRIVATE_KEY`), group `triage0-catcher-group`, policy `triage0-catcher-policy`: `manage instance-family` + `use virtual-network-family` in compartment `triage0-catcher` only. Verified: it cannot list the root compartment or the other two instances.
- `.github/workflows/oracle-catcher.yml` runs `.github/scripts/oci-launch-once.sh` every 15 min on main. On success it opens a GitHub issue "Oracle A1 instance launched". Shape via repo variables `OCPUS` / `MEM_GB`.
- When the instance exists: disable the workflow (Actions → oracle-catcher → Disable), run `service/scripts/oracle/deploy.sh <ip>`, then delete the API key: `oci iam user api-key delete --user-id <user> --fingerprint <fp>`.
- CLI profile `catcher` in `~/.oci/config` uses the same key for local checks.
