# Retell config snapshots

Rollback snapshots of the live Retell LLM + agent config, one folder per
`<timestamp>-<reason>`. Re-apply via `PATCH /update-retell-llm/{llm_id}` and
`PATCH /update-agent/{agent_id}` (see CLAUDE.md → Deployment).

Dated snapshot notes preserve the environment labels and credential provenance recorded at the
time. Any note calling `core-central-vm` production is historical and incorrect under the current
environment model: the VM is sandbox-only, while production uses `bp-voxtable-prod` Secret Manager,
Cloud Run and Cloud SQL. Never use a VM credential or database to replay a production snapshot.

Snapshot notes may record old production test calls or synthetic writes. Those are historical
events, not current instructions. All agent, call and integration testing now runs in staging;
production permits only non-mutating configuration read-back and monitoring.

**Before replaying a snapshot, check its URLs and identifiers.** Older snapshots may embed a
legacy or sandbox hostname. Rewrite a copy to the target environment's declared API URL and assert
that no other-environment identifier remains before applying it.
