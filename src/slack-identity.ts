/**
 * Slack -> Reflect identity resolution.
 *
 * The single rule: a Slack user can use the bot only if their Slack email
 * matches a Reflect user that is bound to the workspace's Reflect team
 * (or, for a solo install, matches the workspace's bound Reflect user).
 *
 * No fallback links, no manual mapping UI. Email IS the key.
 */

import type Database from "better-sqlite3";
import type { SlackWorkspace } from "./slack-workspace-service.js";
import { slackUsersInfo } from "./slack-api.js";

export type ResolveResult =
  | { ok: true; reflectUserId: string; email: string; realName: string | null }
  | { ok: false; reason: string; email: string | null };

interface UserRow {
  id: string;
  email: string | null;
  team_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

/**
 * Resolves a Slack user id to a Reflect user id by matching email. Returns:
 *   - { ok: true, reflectUserId, email, realName } when one Reflect user
 *     matches and is in the right team/solo scope.
 *   - { ok: false, reason } in every refusal case (no email scope,
 *     no matching reflect user, multiple matches, wrong team, ...).
 *
 * Caller is responsible for posting the refusal to Slack.
 */
export async function resolveSlackUserToReflectUser(
  db: Database.Database,
  workspace: SlackWorkspace,
  botToken: string,
  slackUserId: string,
): Promise<ResolveResult> {
  const info = await slackUsersInfo(botToken, slackUserId);
  if (!info.ok) {
    return {
      ok: false,
      email: null,
      reason: `Could not look up your Slack profile (Slack API: ${info.error}).`,
    };
  }
  if (info.data.isBot) {
    return { ok: false, email: null, reason: "bot users cannot use Reflect" };
  }
  if (info.data.isDeleted) {
    return { ok: false, email: null, reason: "deactivated users cannot use Reflect" };
  }
  const email = info.data.email?.trim().toLowerCase() ?? null;
  if (!email) {
    return {
      ok: false,
      email: null,
      reason:
        "Your Slack workspace hasn't granted Reflect the `users:read.email` scope, so I can't see your email to match it. Ask your workspace admin to re-authorise the install with the email scope.",
    };
  }

  const matches = db
    .prepare(
      `SELECT id, email, team_id, first_name, last_name FROM users WHERE LOWER(email) = ? LIMIT 5`,
    )
    .all(email) as UserRow[];

  if (matches.length === 0) {
    return {
      ok: false,
      email,
      reason: `Your Slack email (${email}) doesn't match any Reflect Memory account on this team. Sign up at the dashboard with the same email, or ask the team admin to invite you.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      email,
      reason: `Your Slack email (${email}) matches multiple Reflect accounts. This shouldn't happen — please ping support.`,
    };
  }
  const candidate = matches[0];

  // Workspace is bound to either a Reflect team or a solo Reflect user. The
  // candidate must be on that team / be that user.
  if (workspace.reflectTeamId) {
    if (candidate.team_id !== workspace.reflectTeamId) {
      return {
        ok: false,
        email,
        reason: `Your Reflect account exists, but it isn't on the team this Slack workspace is connected to. Ask the team admin to add ${email} to the team.`,
      };
    }
  } else if (workspace.reflectUserId) {
    if (candidate.id !== workspace.reflectUserId) {
      return {
        ok: false,
        email,
        reason: `This Slack workspace is connected to a single Reflect account that isn't yours.`,
      };
    }
  } else {
    return {
      ok: false,
      email,
      reason: "Workspace is not bound to a Reflect team or user (internal error).",
    };
  }

  const realName =
    info.data.realName ??
    info.data.displayName ??
    ([candidate.first_name, candidate.last_name].filter(Boolean).join(" ") ||
      null);

  return {
    ok: true,
    reflectUserId: candidate.id,
    email,
    realName,
  };
}
