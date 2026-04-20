---
id: EXAMPLE-002
title: Example — how a closed ticket looks
status: done
priority: medium
owner: agent
created: 2026-04-20
closed: 2026-04-20
related:
  - tickets/README.md
  - commit 7989cc9
---

> ⚠️ **This is an example, not a real ticket.** It models the structure of a ticket after it's been closed — frontmatter updated, body annotated with what actually shipped, and an Outcome section appended. Don't delete or modify this file; it's the template for closed tickets.

## Context

Both webhook handlers were silent on success. A verified Stripe delivery returning 200 left no trace in `journalctl`, so there was no way to confirm a webhook had hit our endpoint without querying the DB. During post-cutover validation we had to check a user row's `updated_at` to prove the handler had actually run.

## Proposal

Add 5 log lines across the two webhook code paths:

- `[stripe-webhook] received <id> type=<type>` after signature verifies (`src/server.ts`)
- `[stripe-webhook] processed <id>` after handler returns
- `[clerk-webhook] received type=<type> clerk_id=<id>` after Svix verifies
- `[clerk-webhook] ignored type=<type> ...` for non-user events
- `[billing] No handler for event type <type> (id=<id>)` default case in the Stripe switch (`src/billing-service.ts`)

## Done when

- [x] Patch committed with typecheck clean.
- [x] Deployed via normal pipeline: dev → CI+Deploy green → fast-forward main → CI+SecScan+Deploy green.
- [x] Live-verified on prod by replaying a `customer.subscription.updated` (handled path), an `invoice.paid` (default-case path), and a Clerk `user.created` (Svix path). All three produced the expected log lines.
- [x] `infra/README.md` runbook updated with the new grep pattern.

## Outcome

Shipped as commit `7989cc9` on `main` at 2026-04-20 11:06 UTC. End-to-end verification at 11:10 UTC — full trace captured in `infra/DEPLOY_PLAN.md` migration timeline.

Net effect: every webhook delivery now leaves `received` → optional handler line → `processed` (or `ignored`) in `journalctl`. Silence during a delivery now unambiguously means the request didn't arrive — first thing to check is provider URL configuration.

Tail command:

```bash
journalctl -u reflect-api -f | grep -iE 'stripe-webhook|clerk-webhook|\[billing\]|\[clerk\]'
```
