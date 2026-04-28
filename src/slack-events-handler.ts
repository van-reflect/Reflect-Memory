/**
 * Handles incoming Slack events for the Reflect Memory bot.
 *
 * Phase 3a (this file's current scope): identity resolution + canned reply.
 * Phase 3b will add the Anthropic agent loop with read-only memory tools.
 *
 * Slack imposes a 3-second deadline on webhook ack. The route handler that
 * calls `processSlackEvent` does so as fire-and-forget so the HTTP response
 * goes out immediately. Errors here are logged but never thrown back to the
 * caller.
 */

import type Database from "better-sqlite3";

import { recordAuditEvent } from "./audit-service.js";
import { slackChatPostMessage, slackPostEphemeral } from "./slack-api.js";
import { resolveSlackUserToReflectUser } from "./slack-identity.js";
import {
  getWorkspaceWithToken,
  type SlackWorkspaceWithToken,
} from "./slack-workspace-service.js";

// Minimal Slack event envelope shapes. We intentionally don't pull in
// Slack's massive type definitions; we only touch the fields we need.

export interface SlackEventEnvelope {
  type: string;
  team_id?: string;
  api_app_id?: string;
  event?: {
    type?: string;
    user?: string;
    text?: string;
    channel?: string;
    channel_type?: string;
    ts?: string;
    thread_ts?: string;
    bot_id?: string;
    subtype?: string;
    app_id?: string;
  };
  event_id?: string;
  event_time?: number;
  // url_verification only:
  challenge?: string;
}

export type ProcessResult =
  | { kind: "url_verification"; challenge: string }
  | { kind: "ack" } // event_callback ACK; async work continues in the background
  | { kind: "ignored"; reason: string };

/**
 * Synchronous part of event processing — picks the response type for the
 * Slack-facing HTTP handler. For event_callback we return "ack" and kick the
 * async work off in the background; for url_verification we return the
 * challenge to echo back.
 */
export function processSlackEvent(
  db: Database.Database,
  body: SlackEventEnvelope,
  options: {
    onAsyncError?: (err: unknown) => void;
  } = {},
): ProcessResult {
  if (body.type === "url_verification") {
    return { kind: "url_verification", challenge: body.challenge ?? "" };
  }
  if (body.type !== "event_callback" || !body.event || !body.team_id) {
    return { kind: "ignored", reason: `unhandled top-level type: ${body.type}` };
  }

  const inner = body.event;
  // Defend against bot-echo loops: any message that has a bot_id (or the
  // bot_message subtype, or our own app_id) is skipped.
  if (inner.bot_id) return { kind: "ignored", reason: "bot_id present" };
  if (inner.subtype === "bot_message") return { kind: "ignored", reason: "subtype=bot_message" };
  if (inner.subtype === "message_changed") return { kind: "ignored", reason: "subtype=message_changed" };
  if (inner.subtype === "message_deleted") return { kind: "ignored", reason: "subtype=message_deleted" };
  if (inner.app_id && body.api_app_id && inner.app_id === body.api_app_id) {
    return { kind: "ignored", reason: "self-message" };
  }

  // Only handle the two event types we subscribe to.
  if (inner.type !== "app_mention" && inner.type !== "message") {
    return { kind: "ignored", reason: `event type: ${inner.type}` };
  }
  // For DMs, Slack delivers a generic 'message' event. Restrict to im channels
  // so we don't reply to arbitrary public channel messages without a mention.
  if (inner.type === "message" && inner.channel_type !== "im") {
    return { kind: "ignored", reason: "non-im message without mention" };
  }
  if (!inner.user || !inner.channel || !inner.text) {
    return { kind: "ignored", reason: "incomplete event payload" };
  }

  // Fire-and-forget the async handler. Errors logged via onAsyncError so we
  // never throw past the route handler.
  const handler = handleUserMessage(db, body.team_id, {
    slackUserId: inner.user,
    channel: inner.channel,
    text: inner.text,
    ts: inner.ts ?? "",
    threadTs: inner.thread_ts ?? null,
    isDirectMessage: inner.channel_type === "im",
    eventType: inner.type,
  }).catch((err) => {
    if (options.onAsyncError) options.onAsyncError(err);
    else console.error("[slack-events] async handler crashed", err);
  });
  // Return the promise via the closure so callers (tests) can await it via
  // the same fire-and-forget function below.
  pendingAsyncHandlers.add(handler);
  handler.finally(() => pendingAsyncHandlers.delete(handler));

  return { kind: "ack" };
}

// Pool of in-flight async handlers, exposed for tests so they can await
// completion before assertions. Production code should never await this
// directly (we want to ack Slack instantly).
const pendingAsyncHandlers = new Set<Promise<unknown>>();

/** Test-only: wait for all in-flight async handlers to settle. */
export async function _waitForPendingHandlers(): Promise<void> {
  while (pendingAsyncHandlers.size > 0) {
    await Promise.allSettled(Array.from(pendingAsyncHandlers));
  }
}

interface IncomingMessage {
  slackUserId: string;
  channel: string;
  text: string;
  ts: string;
  threadTs: string | null;
  isDirectMessage: boolean;
  eventType: "app_mention" | "message";
}

async function handleUserMessage(
  db: Database.Database,
  slackTeamId: string,
  msg: IncomingMessage,
): Promise<void> {
  const workspace = getWorkspaceWithToken(db, slackTeamId);
  if (!workspace) {
    // No active workspace bound to this Slack team. Could happen during a
    // race where the bot is still in a Slack channel after we soft-deleted
    // the row. Nothing we can do server-side; just log.
    console.warn(`[slack-events] no active workspace for slack_team_id=${slackTeamId}`);
    return;
  }

  const resolution = await resolveSlackUserToReflectUser(
    db,
    workspace,
    workspace.botToken,
    msg.slackUserId,
  );

  if (!resolution.ok) {
    await postRefusal(workspace, msg, resolution.reason);
    recordAuditEvent(db, {
      userId: workspace.installedByUserId,
      eventType: "slack.auth_refused",
      metadata: {
        slack_team_id: slackTeamId,
        slack_user_id: msg.slackUserId,
        slack_email: resolution.email,
        reason: resolution.reason.slice(0, 200),
      },
    });
    return;
  }

  // Phase 3a: canned reply confirming identity resolution. Phase 3b will
  // replace this with the Anthropic agent loop calling memory tools.
  const where = msg.isDirectMessage ? "in DMs" : "in this channel";
  const text = buildPhase3aReply({
    realName: resolution.realName,
    email: resolution.email,
    where,
  });

  const post = await slackChatPostMessage(workspace.botToken, {
    channel: msg.channel,
    text,
    threadTs: msg.threadTs ?? msg.ts,
  });

  recordAuditEvent(db, {
    userId: resolution.reflectUserId,
    eventType: "slack.message.handled",
    metadata: {
      slack_team_id: slackTeamId,
      slack_user_id: msg.slackUserId,
      slack_channel: msg.channel,
      slack_event_type: msg.eventType,
      reply_ok: post.ok,
      reply_error: post.ok ? null : post.error,
    },
  });

  if (!post.ok) {
    console.warn(
      `[slack-events] failed to post reply: ${post.error}`,
    );
  }
}

function buildPhase3aReply(args: {
  realName: string | null;
  email: string;
  where: string;
}): string {
  const greeting = args.realName ? `Hi ${args.realName}` : "Hi";
  return [
    `${greeting} — I see you (\`${args.email}\`) and I'm here ${args.where}.`,
    `My brain isn't wired up yet — that's the next deploy. Once it lands, I'll be able to read and search your Reflect memories from here.`,
  ].join("\n\n");
}

async function postRefusal(
  workspace: SlackWorkspaceWithToken,
  msg: IncomingMessage,
  reason: string,
): Promise<void> {
  const text = `Reflect Memory — access refused\n\n${reason}`;
  if (msg.isDirectMessage) {
    // In a DM there's only one user; a regular reply is fine.
    await slackChatPostMessage(workspace.botToken, {
      channel: msg.channel,
      text,
      threadTs: msg.threadTs ?? msg.ts,
    });
  } else {
    // Channel: ephemeral so we don't shame the requester publicly.
    await slackPostEphemeral(workspace.botToken, {
      channel: msg.channel,
      user: msg.slackUserId,
      text,
    });
  }
}
