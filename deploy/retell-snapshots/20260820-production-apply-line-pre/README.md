# ⚠️ Do not trust this snapshot — wrong workspace, contaminated pre-state

Kept as evidence, not as a record of production.

`agent.json` here is `agent_3bedcbdd77017136e5b4ade412` in the **legacy Algorythmos workspace**,
captured because the script that took it inherited the repo's local `.env` Retell key. It is
**not** the production agent. Production's Mazcina agent is
`agent_b6b6488af08b82d80e8f4d270a`, in the **Biteperk** workspace, reachable only with the key
in the VM's `/opt/vocotable/.env`.

Two things make this directory actively misleading, which is why it says so at the top:

1. **Wrong estate.** Every value in `agent.json`/`llm.json` describes an agent nothing routes to.
2. **Contaminated "pre".** The first apply run had already PATCHed the agent before the second
   run took this snapshot, so it records a post-change state under a `-pre` name. `apply-line.mjs`
   now refuses to overwrite an existing pre-snapshot for exactly this reason.

## What actually happened

The database was repointed from `agent_b6b6488af08b82d80e8f4d270a` (correct) to
`agent_3bedcbdd77017136e5b4ade412` (a different workspace's agent), on the strength of a
wrong-key reading that made the correct agent look non-existent. **The production line stopped
answering for roughly two hours** and was restored by putting the original binding back.

Also changed in the legacy workspace and not ours to change: that agent was renamed to
`Mazcina Resto-Bar (production)` and given a pronunciation dictionary. Reverting it was attempted
and is still outstanding.

## What was true all along

`+61 468 202 846` was imported correctly in the Biteperk workspace the entire time, webhook-only,
pointing at `https://api.biteperk.com.au/retell/inbound`. Four real calls reached the agent on
20 Aug. The only genuine fault on this line is the ~7.6 s fixed-timer drop
(`deploy/runbooks/incident-7600ms-call-drops.md`).
