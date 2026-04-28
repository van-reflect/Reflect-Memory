/**
 * Per-Slack-thread short-term conversation state.
 *
 * Stored as a compact JSON array of {role, content} pairs in the
 * `slack_conversation_state` table. TTL'd to 24 hours so the table stays
 * small; deeper history is what Reflect Memory itself is for.
 *
 * We deliberately store ONLY user-text and assistant-text turns. Tool-use
 * cycles within an agent turn are NOT persisted — they balloon the payload
 * and don't help the model on the next turn (it can re-tool if needed).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TURNS = 20; // user+assistant pairs; truncate older to keep payloads bounded

interface ConversationRow {
  messages_json: string;
}

export function getConversation(
  db: Database.Database,
  slackWorkspaceId: string,
  channelId: string,
  threadTs: string,
): StoredMessage[] {
  const row = db
    .prepare(
      `SELECT messages_json FROM slack_conversation_state
       WHERE slack_workspace_id = ? AND channel_id = ? AND thread_ts = ?
         AND expires_at > ?`,
    )
    .get(slackWorkspaceId, channelId, threadTs, new Date().toISOString()) as
    | ConversationRow
    | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.messages_json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredMessage);
  } catch {
    return [];
  }
}

function isStoredMessage(value: unknown): value is StoredMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
  );
}

export function saveConversation(
  db: Database.Database,
  slackWorkspaceId: string,
  channelId: string,
  threadTs: string,
  messages: StoredMessage[],
): void {
  // Keep only the most recent MAX_TURNS messages (user+assistant pairs).
  const trimmed = messages.slice(-MAX_TURNS * 2);
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);
  const json = JSON.stringify(trimmed);

  const existing = db
    .prepare(
      `SELECT id FROM slack_conversation_state
       WHERE slack_workspace_id = ? AND channel_id = ? AND thread_ts = ?`,
    )
    .get(slackWorkspaceId, channelId, threadTs) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE slack_conversation_state
       SET messages_json = ?, updated_at = ?, expires_at = ?
       WHERE id = ?`,
    ).run(json, now.toISOString(), expires.toISOString(), existing.id);
  } else {
    db.prepare(
      `INSERT INTO slack_conversation_state
        (id, slack_workspace_id, channel_id, thread_ts, messages_json, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      slackWorkspaceId,
      channelId,
      threadTs,
      json,
      now.toISOString(),
      expires.toISOString(),
    );
  }
}

/**
 * Removes expired rows. Cheap to run lazily on every save call (the index on
 * expires_at makes this fast even on large tables) so we don't need a cron.
 */
export function pruneExpiredConversations(db: Database.Database): void {
  db.prepare(
    `DELETE FROM slack_conversation_state WHERE expires_at <= ?`,
  ).run(new Date().toISOString());
}
