# Retell config snapshots

Rollback snapshots of the live Retell LLM + agent config, one folder per
`<timestamp>-<reason>`. Re-apply via `PATCH /update-retell-llm/{llm_id}` and
`PATCH /update-agent/{agent_id}` (see CLAUDE.md → Deployment).

**Before replaying a snapshot, check its URLs.** Every snapshot embeds the
production API hostname (`https://vocotable.algorythmos.com.au/...`) in the
tool, inbound and webhook URLs. That hostname is deliberately kept stable, but
if it ever changes (the future API-domain migration), replaying an old snapshot
verbatim would re-point the live agent at a dead host mid-call. Rewrite the
URLs in a copy first, then apply the copy.
