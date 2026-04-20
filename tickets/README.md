# Tickets

Lightweight ticket tracking that lives in the repo. One markdown file per ticket. Moving a file from `todo/` to `done/` closes it.

Why in-repo? Tickets travel with the code, diff review shows what shipped, and grep works.

---

## Structure

```
tickets/
├── README.md        ← you are here
├── todo/            ← open tickets
└── done/            ← closed tickets (move files here when shipped)
```

## Filename convention

`NNN-short-kebab-slug.md`

- `NNN` — zero-padded sequential ID (`001`, `002`, … `042`). Stays stable for the life of the ticket.
- `slug` — 3-5 lowercase words, hyphens between. Describes the what, not the how.

Examples:
- `012-webhook-idempotency-table.md`
- `037-strengthen-dashboard-smoke-test.md`
- `EXAMPLE-001-example-open-ticket.md` (the `EXAMPLE-` prefix is reserved for… examples)

Find the next ID with `ls tickets/todo tickets/done | grep -oE '^[0-9]+' | sort -n | tail -1`.

## File contents

Every ticket starts with YAML frontmatter, then a free-form body. Keep bodies short — one to three paragraphs is usually enough. Link to PRs, commits, or docs rather than duplicating.

```yaml
---
id: 012
title: Webhook idempotency table
status: todo              # todo | done
priority: medium          # high | medium | low | trivial
owner: agent              # agent | user | <name>
created: 2026-04-20
closed:                   # fill when moving to done/
related:                  # optional: issue numbers, PR refs, other tickets
  - PR #42
  - tickets/done/008-...
---

## Context
Why this matters. What breaks without it.

## Proposal
What we'll actually do. Keep concrete, link to relevant code.

## Done when
- [ ] Bullet list of observable completion criteria.
- [ ] Tests / checks that confirm.
```

## Workflow

**Open a ticket:**
1. `cp tickets/todo/EXAMPLE-001-example-open-ticket.md tickets/todo/NNN-slug.md`
2. Fill in frontmatter and body.
3. Commit on a feature branch or directly to `dev`.

**Work a ticket:**
- Reference the ticket ID in commit messages: `feat: add processed_webhook_events table (#012)`.
- Keep the ticket body updated if scope changes materially.

**Close a ticket:**
1. `git mv tickets/todo/NNN-slug.md tickets/done/NNN-slug.md`
2. Update frontmatter: `status: done` and fill `closed:` date.
3. Add a short "Outcome" section at the bottom with the PR or commit link.
4. Commit and push.

`git mv` matters — it preserves rename detection so `git log --follow tickets/done/NNN-slug.md` shows the full history.

## Priorities

| Priority | Use for |
|---|---|
| high | Customer-visible bugs, security, blockers. Should ship this week. |
| medium | Code quality, observability, operational toil. Should ship this month. |
| low | Nice-to-haves, refactors with no urgency. |
| trivial | Cosmetic, tidy-up, secret-cleanup. Do when touching the file anyway. |

## Not in scope

- **Long-running product planning** → `infra/DEPLOY_PLAN.md`-style docs or product briefs.
- **Architecture decisions** → ADRs (if/when we adopt them).
- **Secrets, customer data, incident postmortems with PII** → keep out of git entirely.

## See also

- `infra/README.md` — devops runbook
- `infra/DEPLOY_PLAN.md` — migration history and outstanding follow-ups (some will graduate into individual tickets here)
