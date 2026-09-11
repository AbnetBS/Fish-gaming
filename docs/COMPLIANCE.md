# Real money, licensing and responsible gaming

This document is part of the product. It exists so that nobody has to guess, or decide from
scratch, what stands between this codebase and a money-bearing game.

## Current posture

```
REAL_MONEY_ENABLED = false        # environment flag, read at process start
```

While this is the case:

* The only currency is **DEMO COINS**: virtual, integer, non-transferable, non-purchasable,
  non-withdrawable, with no cash value and no redemption of any kind.
* New accounts receive a welcome demo credit so the product can be evaluated. `GET
  /api/payments/demo-topup` grants more for free, rate-limited, and is labelled as such. There
  is no price anywhere in the UI or the API.
* `POST /api/payments/deposit` and `POST /api/payments/withdraw` exist as **explicit dead ends**
  returning `403 REAL_MONEY_DISABLED`, so the surface is auditable rather than absent and
  nobody can assume a hidden path exists.
* `PaymentProvider` is an interface; the only implementation is `DemoPaymentProvider`, whose
  `settlesRealMoney` is `false` and whose value-moving methods reject.
* The ledger schema has no real-money column, no FX rate, no payout address, no KYC document
  store and no settlement table.

Boot behaviour: if `REAL_MONEY_ENABLED=true` **and** `NODE_ENV=production`, the process refuses
to start unless `REAL_MONEY_ATTESTATION` supplies a compliance attestation string. The admin
panel additionally refuses to write any system setting whose key looks like real-money or
payment configuration — flipping posture is an environment/deployment decision with a
sign-off, not a dashboard toggle.

## What enabling real money actually requires

A licence for a physical gaming venue does **not** authorise online real-money gaming. Before
any real-money deployment, an operator must independently establish, per jurisdiction:

1. **Licensing / authorisation** — a valid remote gambling or gaming licence from the relevant
   regulator, plus any technical-system certification it requires.
2. **Age assurance** — verification meeting the local standard (18+, 21+ or higher), with an
   audit trail.
3. **KYC / identity** — document and database verification before first funding; ongoing
   refresh on risk triggers.
4. **AML / CTF** — sanctions and PEP screening, source-of-funds and enhanced due diligence
   thresholds, transaction monitoring, suspicious-activity reporting, record retention periods.
5. **Geographic controls** — IP plus documentary location verification, blocking where online
   real-money play is not permitted, and no circumvention posture.
6. **Payment rails** — only providers whose terms permit the specific activity; webhook
   signature verification, settlement reconciliation, chargeback handling, segregation of player
   funds where required.
7. **Game certification** — certified RNG, published and enforced RTP, tamper-evident game
   configuration, and independent testing-house sign-off on the math model.
8. **Responsible gaming** — deposit, loss, wager and time limits; cooling-off; self-exclusion
   with cross-brand enforcement; reality checks; access to play-history summaries; trained
   support and escalation routes; helpline signposting.

   This codebase already implements the *non-financial* subset server-side, and it is enforced in
   the play path rather than displayed: a daily play limit in minutes (shots refused and round
   closed when it elapses), player-initiated self-exclusion that only an admin can lift (audited),
   a play-time readout in the game HUD, and new-sign-in alerts the player can switch on. What is
   missing for real money is everything that touches funds — deposit/loss/wager limits, cooling-off
   as a regulated product feature, cross-brand exclusion propagation, and the retention and
   reporting obligations that come with them.
9. **Advertising rules** — no misleading claims, age-gated targeting, responsible-play messaging
   in creative, affiliate oversight.
10. **Tax and accounting** — gaming duties, VAT/GST treatment, reporting obligations.
11. **Data protection** — lawful basis and retention schedule for identity documents and
    financial data, DPIA, breach-notification process.
12. **Accessibility & consumer duty** — the obligations the regulator attaches to fair customer
    outcomes.

## What this software deliberately does not provide

There is no configuration, flag, table row, API parameter, code path or build variant that
disables, bypasses, fakes or works around any item above. In particular:

* No "test mode" that moves value.
* No way to accept a client-side claim of payment.
* No way to credit a wallet from a request body.
* No way to disable age/KYC/geo checks, because they are not implemented as toggles — the real
  implementations must be added as part of a licensed programme, alongside the evidence.
* No per-player outcome manipulation. This is a hard design property, not a policy: no reward
  code path reads identity, balance, deposit history, previous wins or losses. There are tests
  asserting that three different players with the same shot sequence receive the same rewards.

## Responsible gaming in the demo today

The demo is not a gambling product, but the habit infrastructure is real and enforced
server-side so it exists before any future money, rather than being retrofitted:

* Session-limit setting stored per account and enforced by the client banner + server-stored
  preference (`profiles.session_limit_min`).
* Explicit "demo coins are not money" labelling on every screen showing a balance.
* 18+ statement on the landing page, auth pages, footer and the dedicated policy page.
* No countdown/loss-chasing mechanics, no "near miss" staging, no purchased advantage, no
  leaderboard prizes, no push notifications urging return.
* A `/responsible-gaming` page stating the currency's status and signposting help.

## Guidance if this code is reused

If you operate a venue game room product and are considering real money, engage counsel and the
regulator first, then treat this repository as the arcade/demo skeleton. The ledger,
configuration versioning, audit trail, session controls and authority model are the parts that
carry over; the missing parts (KYC, geo, payments, certification) are the regulated work, not a
development spike.
