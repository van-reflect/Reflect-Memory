---
id: EXAMPLE-001
title: Example — how an open ticket looks
status: todo
priority: medium
owner: agent
created: 2026-04-20
related:
  - tickets/README.md
---

> ⚠️ **This is an example, not a real ticket.** Copy it when opening a new one, then delete this banner. Don't edit or close this file — it's the template.

## Context

Every open ticket explains *why it matters* in 1–3 sentences. Aim for the kind of context someone coming back to this in six months will thank you for. Link to the code, the commit, the conversation, the dashboard — don't re-explain what a `git blame` would tell you.

Good context answers "what breaks if we never do this?" — e.g. "Today the Stripe webhook handler is idempotent by accident (UPDATEs set target state, not deltas). If we ever add counter-incrementing side effects, a single Stripe replay could double-count. We should close the gap before that happens."

## Proposal

The concrete thing we'll do. Link to files by path. Keep it executable:

- Add a `processed_webhook_events` table: `(event_id PK, provider, received_at)`.
- In `src/server.ts` around the `/webhooks/stripe` handler, check-then-insert before calling `handleStripeWebhook`.
- Same for `/webhooks/clerk`.
- Decision: if we see a duplicate, we return `200 {received: true, duplicate: true}` and skip the handler entirely.

## Done when

- [ ] Table created via migration in `src/migrations/`.
- [ ] Both webhook routes guarded, with a unit test covering the replay case.
- [ ] Live-verified on dev: send the same event twice, see one DB write and one `[stripe-webhook] duplicate` log line.
- [ ] Ticket moved to `tickets/done/` with a PR link in Outcome.
