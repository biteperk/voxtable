#!/bin/zsh
# check-all-lines.sh [--strict]
# Runs assert-line.mjs over every number in deploy/voice-lines.json, loading each
# environment's credentials from where they actually live. Exits non-zero if any line is broken.
#
# This is what the schedule runs. Before it existed, a binding could vanish and the only
# detector was Sam placing a call — which is how a dead production line went unnoticed for a day.
set -u
cd "${0:a:h}/../../../.." || exit 2
STRICT="${1:-}"
fail=0

lines=$(node -e 'const d=require("./deploy/voice-lines.json");console.log(Object.keys(d.lines).join(" "))') || exit 2

for number in ${=lines}; do
  env=$(node -e "console.log(require('./deploy/voice-lines.json').lines['$number'].environment)")
  echo "\n═══ $number ($env) ═══"

  case "$env" in
    staging)
      RETELL_API_KEY=$(gcloud secrets versions access latest --secret=voxtable-stg-retell-api-key --project=bp-voxtable-stg 2>/dev/null)
      RETELL_WEBHOOK_SECRET="$RETELL_API_KEY"   # the staging workspace's single key serves as both
      TWILIO_AU1_KEY_SID=$(gcloud secrets versions access latest --secret=voxtable-stg-twilio-au1-key-sid --project=bp-voxtable-stg 2>/dev/null)
      TWILIO_AU1_KEY_SECRET=$(gcloud secrets versions access latest --secret=voxtable-stg-twilio-au1-key-secret --project=bp-voxtable-stg 2>/dev/null)
      ;;
    production)
      RETELL_API_KEY=$(grep '^RETELL_API_KEY=' .env | cut -d= -f2-)
      # Production verifies /retell/inbound with the WEBHOOK secret, a different string from the
      # API key — signing with the API key 401s and looks exactly like a broken backend.
      # Read it from the VM each run rather than keeping another copy on disk.
      RETELL_WEBHOOK_SECRET=$(gcloud compute ssh core-central-vm --zone us-central1-a \
        --project vocotable-497209 --command "grep '^RETELL_WEBHOOK_SECRET=' /opt/vocotable/.env" 2>/dev/null | cut -d= -f2-)
      # No AU1 API key exists for the production Twilio account, so the trunk layer is
      # unverifiable there and assert-line will say so rather than tick it.
      # Left deliberately empty (not a secret; written this way so the secret scanner does
      # not read `KEY_SECRET="..."` as a hard-coded credential).
      TWILIO_AU1_KEY_SID=
      TWILIO_AU1_KEY_SECRET=
      ;;
  esac

  RETELL_API_KEY="$RETELL_API_KEY" RETELL_WEBHOOK_SECRET="$RETELL_WEBHOOK_SECRET" \
  TWILIO_AU1_KEY_SID="$TWILIO_AU1_KEY_SID" TWILIO_AU1_KEY_SECRET="$TWILIO_AU1_KEY_SECRET" \
    node .claude/skills/retell-agent-quality/scripts/assert-line.mjs "$number" $STRICT || fail=1
done

echo ""
if [ $fail -ne 0 ]; then
  echo "AT LEAST ONE VOICE LINE IS BROKEN — see the failing check ids above."
  echo "Repair: node .claude/skills/retell-agent-quality/scripts/apply-line.mjs <number> --apply"
else
  echo "All declared voice lines match deploy/voice-lines.json."
fi
exit $fail
