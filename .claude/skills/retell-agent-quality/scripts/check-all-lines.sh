#!/bin/zsh
# check-all-lines.sh [--strict]
# Runs assert-line.mjs over every number in deploy/voice-lines.json. Exits non-zero if any
# line is broken.
#
# It no longer handles credentials. It used to read the production key from the repo's local
# .env, which holds the LEGACY workspace's key — so the production line was checked against
# the wrong estate, reported as broken, and "repaired" into a real two-hour outage on
# 20 Aug 2026. Each line now declares where its credentials come from and the checker fetches
# them itself.
set -u
cd "${0:a:h}/../../../.." || exit 2
STRICT="${1:-}"
fail=0

lines=$(node -e 'const d=require("./deploy/voice-lines.json");console.log(Object.keys(d.lines).join(" "))') || exit 2

for number in ${=lines}; do
  env=$(node -e "console.log(require('./deploy/voice-lines.json').lines['$number'].environment)")
  echo "\n═══ $number ($env) ═══"

  # Retell credentials are resolved by the script itself, and so is the account-token pair a
  # ROUTER-mode line declares under routing.twilio_auth. Only a trunk line's AU1/US1 API-key pair
  # is still passed through the environment, loaded here from the secret names the line declares.
  # An empty prefix means the trunk layer reports itself unverified rather than silently ticking.
  tw=$(node -e "console.log(require('./deploy/voice-lines.json').lines['$number'].twilio_au1_key_secret || '')")
  sid="" secret=""
  if [ -n "$tw" ]; then
    # Keep the Twilio project explicit. Sandbox declarations may use a different credential
    # source, while production credentials must remain in bp-voxtable-prod Secret Manager.
    # Guessing the project can pass empty credentials and leave the trunk unverified.
    proj=$(node -e "const l=require('./deploy/voice-lines.json').lines['$number']; console.log(l.twilio_key_project || l.retell_credentials.gcp_project || 'bp-voxtable-stg')")
    sid=$(gcloud secrets versions access latest --secret="${tw}-sid" --project="$proj" 2>/dev/null)
    secret=$(gcloud secrets versions access latest --secret="${tw}-secret" --project="$proj" 2>/dev/null)
  fi

  # A router line also gets the call-outcome check: the most recent SIP leg to Retell in the
  # last 24 h must have connected. That is the check that would have gone red at 23:38Z on
  # 5 Sep 2026, when the configuration was perfect and Retell simply did not answer.
  # ${=calls} below: zsh does not word-split an unquoted variable, so "$calls" would arrive as ONE
  # argument "--calls 24" and the flag would be silently ignored (it was, on the first run).
  calls=""
  if [ "$(node -e "console.log((require('./deploy/voice-lines.json').lines['$number'].routing||{}).mode||'trunk')")" = "router" ]; then
    calls="--calls 24"
  fi
  TWILIO_AU1_KEY_SID="$sid" TWILIO_AU1_KEY_SECRET="$secret" \
    node .claude/skills/retell-agent-quality/scripts/assert-line.mjs "$number" $STRICT ${=calls} || fail=1
done

echo ""
if [ $fail -ne 0 ]; then
  echo "AT LEAST ONE VOICE LINE IS BROKEN — see the failing check ids above."
  echo "If BOTH the number and the agent are missing, suspect the credentials before the line."
  echo "Repair (trunk line): node .claude/skills/retell-agent-quality/scripts/apply-line.mjs <number> --apply"
  echo "Switch (router line): node .claude/skills/retell-agent-quality/scripts/switch-line.mjs <number> --to <profile> --apply"
else
  echo "All declared voice lines match deploy/voice-lines.json."
fi
exit $fail
