# BitePerk Retell workspace — first build (13 Aug 2026)

Both venues rebuilt in the BitePerk-owned workspace (`biteperk@gmail.com`),
replacing the workspace whose login sits on the retired `algorythmos.com.au`
domain. **Nothing here is live yet** — production still points at the old
workspace, and the phone number has not moved.

| Venue | Agent | LLM |
|---|---|---|
| Natalia's Bistro | `agent_5b5df167525452db98cda2112f` | `llm_18ad6f5adedc865b7ffd02a121e1` |
| Cuban Corner Parramatta | `agent_2892d65ceace4e68d8a3f3e80c` | `llm_53c6e9de9aac3b60270ffdd6bcba` |

Built from the **live** config captured the same day in
`../20260813-pre-account-migration/`, not from older snapshots — the live
greeting carries the AI + recording disclosure that no snapshot recorded, and
the live agent carries `data_storage_retention_days: 30`. Both are preserved
here; 19 read-back assertions confirmed it.

`default_dynamic_variables` is deliberately **empty** in both LLMs. Nothing in
production refreshes them, so a stored value is frozen forever and only ever
surfaces when the inbound webhook fails — greeting the caller with the wrong
venue and stale dates at precisely the worst moment.

The workspace's single API key is badged as the **Webhook key**, so at cutover
`RETELL_API_KEY` and `RETELL_WEBHOOK_SECRET` take the same value. That secret
was verified offline against the SDK's actual scheme
(`v=<timestamp>,d=<hmac(secret, body+timestamp)>`, 5-minute replay window):
it accepts a correctly signed body and rejects a foreign key, a tampered body,
and a 10-minute-old timestamp.

Not done here, and required before this workspace can serve traffic: a payment
method on the account (number operations 402 without one), and the number move,
which is delete-then-import with no way back. See the cutover order in
`../../runbooks/` and the migration memory note.
