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
import { getLlmKeyPlaintext } from "./llm-key-service.js";
import { runSlackAgentTurn } from "./slack-agent.js";
import { slackChatPostMessage, slackPostEphemeral } from "./slack-api.js";
import {
  getConversation,
  pruneExpiredConversations,
  saveConversation,
} from "./slack-conversation-service.js";
import { resolveSlackUserToReflectUser } from "./slack-identity.js";
import {
  getWorkspaceWithToken,
  type SlackWorkspaceWithToken,
} from "./slack-workspace-service.js";

// Minimal Slack event envelope shapes. We intentionally don't pull in
// Slack's massive type definitions; we only touch the fields we need.

export interface SlackEventEnvelope {
  type: string;
  org_id?: string;
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
  if (body.type !== "event_callback" || !body.event || !body.org_id) {
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
  const handler = handleUserMessage(db, body.org_id, {
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

  // Resolve which scope the LLM key lives under: prefer the workspace's
  // bound team key (if any), else the workspace's solo user key.
  const llmKeyScope = workspace.reflectTeamId
    ? { orgId: workspace.reflectTeamId, userId: null }
    : { orgId: null, userId: workspace.reflectUserId ?? resolution.reflectUserId };
  const apiKey = (() => {
    try {
      return getLlmKeyPlaintext(db, llmKeyScope, "anthropic");
    } catch (err) {
      console.error("[slack-events] failed to load LLM key", err);
      return null;
    }
  })();

  if (!apiKey) {
    await postReply(workspace, msg,
      "_Reflect Memory needs an Anthropic API key before I can answer. " +
      "Open the dashboard at *Connections \u2192 Slack* and paste a key in the *LLM provider key* section, then try again._",
    );
    recordAuditEvent(db, {
      userId: resolution.reflectUserId,
      eventType: "slack.message.handled",
      metadata: {
        slack_team_id: slackTeamId,
        slack_user_id: msg.slackUserId,
        slack_channel: msg.channel,
        slack_event_type: msg.eventType,
        outcome: "no_llm_key",
      },
    });
    return;
  }

  // Identify the conversation thread for state. App mentions in a channel
  // attach to the thread the mention is in (or start one at this message);
  // DMs use the message ts as the thread root.
  const threadTs = msg.threadTs ?? msg.ts;
  const history = getConversation(db, workspace.id, msg.channel, threadTs);

  let replyText: string;
  let toolCallCount = 0;
  let steps = 0;
  let stopReason = "unknown";
  try {
    const result = await runSlackAgentTurn({
      apiKey,
      db,
      reflectUserId: resolution.reflectUserId,
      isDirectMessage: msg.isDirectMessage,
      email: resolution.email,
      realName: resolution.realName,
      newUserMessage: msg.text,
      history,
    });
    replyText = result.replyText;
    toolCallCount = result.toolCallCount;
    steps = result.steps;
    stopReason = result.stopReason;
    saveConversation(db, workspace.id, msg.channel, threadTs, result.updatedHistory);
    pruneExpiredConversations(db);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error("[slack-events] agent turn failed", err);
    replyText = `_Sorry — something broke on my end (${errMsg.slice(0, 200)}). The error has been logged._`;
  }

  const post = await postReply(workspace, msg, replyText);

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
      tool_calls: toolCallCount,
      agent_steps: steps,
      stop_reason: stopReason,
    },
  });

  if (!post.ok) {
    console.warn(`[slack-events] failed to post reply: ${post.error}`);
  }
}

async function postReply(
  workspace: SlackWorkspaceWithToken,
  msg: IncomingMessage,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await slackChatPostMessage(workspace.botToken, {
    channel: msg.channel,
    text,
    threadTs: msg.threadTs ?? msg.ts,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
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
