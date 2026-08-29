# Staging agent joins the fillers-ON decision

**30 Aug 2026.** One PATCH to `llm_c1d40dbe180e737dd2ce1309ed3f` (Staging workspace):
`speak_during_execution: true` on every functional tool. Nothing else touched.

Found by the machine, which is the point: the first fully-credentialed run of
`voice-line-health.yml` (prod repo secrets set + staging SA granted secret access, both today)
failed the staging line on exactly this — the agent still carried the fillers-off state from
the now-rejected `pipeline-environment-checks` rationale. The decision (Sam, 29 Aug, recorded
at `assert-agent.mjs`) is fillers ON everywhere.

Read-back (pasted): `readback: all functional tools during+after true: True`

Next dispatched health run: **all three jobs green** — coverage, staging line, production
line — the workflow's first full pass.

Rollback: re-apply `../20260830-staging-fillers-on-pre/llm.json` via
`PATCH /update-retell-llm/llm_c1d4…`.
