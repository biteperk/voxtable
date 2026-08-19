#!/bin/zsh
# snapshot.sh <agent_id> <llm_id> <out_dir>
# Dumps the live agent + LLM to <out_dir>/{agent,llm}.json for pre/post records.
# Requires RETELL_API_KEY in the environment (see references/api-operations.md).
set -e
[ -n "$RETELL_API_KEY" ] || { echo "RETELL_API_KEY not set" >&2; exit 1; }
[ $# -eq 3 ] || { echo "usage: snapshot.sh <agent_id> <llm_id> <out_dir>" >&2; exit 1; }
mkdir -p "$3"
curl -sf "https://api.retellai.com/get-agent/$1" -H "Authorization: Bearer $RETELL_API_KEY" > "$3/agent.json"
curl -sf "https://api.retellai.com/get-retell-llm/$2" -H "Authorization: Bearer $RETELL_API_KEY" > "$3/llm.json"
node -e '
const a=require(process.argv[1]+"/agent.json"), l=require(process.argv[1]+"/llm.json");
console.log("agent:", a.agent_id, "voice:", a.voice_id, "| llm:", l.llm_id, "prompt", l.general_prompt.length, "chars");
console.log("Snapshot written. Add a README (what/why/rollback) before committing.");
' "$3"
