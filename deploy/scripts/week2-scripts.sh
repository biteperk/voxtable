#!/usr/bin/env bash
set -euo pipefail

echo "RETIRED: core-central-vm is sandbox-only; never copy its config or data into production." >&2
echo "Use biteperk-cloud-platform, bp-voxtable-prod Secret Manager, Cloud Run and Cloud SQL." >&2
exit 1
