# Draft reply for Twilio ticket 28926493 — add staging SID to the BitePerk sender ID

Send from sam@biteperk.com.au (the ticket correspondent) as a reply on ticket 28926493
(senderid@twilio.com). Delete this file once sent; record the outcome in
`deploy/runbooks/acma-sender-id-registration.md` §5.

---

Subject: Re: [28926493] Alphanumeric Sender ID registration — add an additional Account SID

Hi team,

Following up on our approved `BitePerk` Alphanumeric Sender ID registration (ACMA, Australia),
currently registered against Account SID ACd423bd09e9649e552a0b6d19a9eed338 (Biteperk-production).

As discussed with Ankita on this ticket (12 Aug), additional Account SIDs can be added to an
existing registration. Please add our staging account to the approved registration:

- Account SID to add: AC8116857da2064ef3251533f3ade56f32 (friendly name: Biteperk-staging)
- Same legal entity: BITEPERK PTY LTD, ABN 36 700 831 303
- Sender ID: BitePerk (unchanged)

Both accounts sit under the same Twilio Organization ("My Organization", owner
twilio@biteperk.com.au). The staging account is used for internal pre-production testing only.

Two questions while you have the registration open:

1. Does adding an additional Account SID affect the registration fee or trigger a new review
   period, and if so, what should we expect?
2. If we later create subaccounts under ACd423bd09e9649e552a0b6d19a9eed338 (one per restaurant
   customer, provisioned programmatically), do those subaccounts inherit the approved sender ID
   from the parent, or does each subaccount need to be added to the registration individually?
   This determines our provisioning design, so a definitive answer would help us a lot.

Thanks,
Sam Kalaliya
BitePerk Pty Ltd
