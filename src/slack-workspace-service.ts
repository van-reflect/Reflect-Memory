/**
 * Slack workspace service — CRUD for the `slack_workspaces` table.
 *
 * Persists OAuth-installed Slack workspaces, their bot tokens (encrypted at
 * rest), and the link to a Reflect team or solo user. Soft-delete via
 * `uninstalled_at` so we keep audit history of installs.
 *
 * Bot tokens are encrypted with the same crypto module as LLM keys but use a
 * salt of `slack:<slack_team_id>` so each workspace's token has a different
 * derived sub-key.
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

import { recordAuditEvent } from "./audit-service.js";
import {
  decryptSlackBotToken,
  encryptSlackBotToken,
} from "./llm-key-crypto.js";

export interface SlackWorkspace {
  id: string;
  slackTeamId: string;
  slackTeamName: string;
  reflectTeamId: string | null;
  reflectUserId: string | null;
  botUserId: string;
  installedByUserId: string | null;
  installedAt: string;
  uninstalledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackWorkspaceWithToken extends SlackWorkspace {
  /** Decrypted bot token (xoxb-...). Use only when actually calling Slack. */
  botToken: string;
}

interface SlackWorkspaceRow {
  id: string;
  slack_team_id: string;
  slack_team_name: string;
  reflect_team_id: string | null;
  reflect_user_id: string | null;
  bot_user_id: string;
  bot_token_encrypted: Buffer;
  bot_token_nonce: Buffer;
  installed_by_user_id: string | null;
  installed_at: string;
  uninstalled_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToWorkspace(row: SlackWorkspaceRow): SlackWorkspace {
  return {
    id: row.id,
    slackTeamId: row.slack_team_id,
    slackTeamName: row.slack_team_name,
    reflectTeamId: row.reflect_team_id,
    reflectUserId: row.reflect_user_id,
    botUserId: row.bot_user_id,
    installedByUserId: row.installed_by_user_id,
    installedAt: row.installed_at,
    uninstalledAt: row.uninstalled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertSlackWorkspaceOptions {
  slackTeamId: string;
  slackTeamName: string;
  reflectTeamId: string | null;
  reflectUserId: string | null;
  botUserId: string;
  botToken: string;
  installedByUserId: string;
  requestId?: string | null;
}

/**
 * Inserts or updates a Slack workspace install. If the slack_team_id already
 * exists, the row is updated (re-install) and its uninstalled_at is cleared.
 */
export function upsertSlackWorkspace(
  db: Database.Database,
  options: UpsertSlackWorkspaceOptions,
): SlackWorkspace {
  if (options.reflectTeamId && options.reflectUserId) {
    throw new Error(
      "upsertSlackWorkspace: exactly one of reflectTeamId or reflectUserId must be set",
    );
  }
  if (!options.reflectTeamId && !options.reflectUserId) {
    throw new Error(
      "upsertSlackWorkspace: one of reflectTeamId or reflectUserId is required",
    );
  }

  const encrypted = encryptSlackBotToken(options.botToken, options.slackTeamId);
  const now = new Date().toISOString();

  const existing = db
    .prepare(
      `SELECT * FROM slack_workspaces WHERE slack_team_id = ?`,
    )
    .get(options.slackTeamId) as SlackWorkspaceRow | undefined;

  let workspaceId: string;
  let isNew = false;

  if (existing) {
    workspaceId = existing.id;
    db.prepare(
      `UPDATE slack_workspaces
       SET slack_team_name = ?, reflect_team_id = ?, reflect_user_id = ?,
           bot_user_id = ?, bot_token_encrypted = ?, bot_token_nonce = ?,
           installed_by_user_id = ?, installed_at = ?, uninstalled_at = NULL,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      options.slackTeamName,
      options.reflectTeamId,
      options.reflectUserId,
      options.botUserId,
      encrypted.ciphertext,
      encrypted.nonce,
      options.installedByUserId,
      now,
      now,
      existing.id,
    );
    recordAuditEvent(db, {
      userId: options.installedByUserId,
      eventType: "slack.reinstalled",
      requestId: options.requestId ?? null,
      metadata: {
        slack_team_id: options.slackTeamId,
        slack_team_name: options.slackTeamName,
        reflect_team_id: options.reflectTeamId,
        reflect_user_id: options.reflectUserId,
      },
    });
  } else {
    workspaceId = randomUUID();
    isNew = true;
    db.prepare(
      `INSERT INTO slack_workspaces (
        id, slack_team_id, slack_team_name, reflect_team_id, reflect_user_id,
        bot_user_id, bot_token_encrypted, bot_token_nonce,
        installed_by_user_id, installed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceId,
      options.slackTeamId,
      options.slackTeamName,
      options.reflectTeamId,
      options.reflectUserId,
      options.botUserId,
      encrypted.ciphertext,
      encrypted.nonce,
      options.installedByUserId,
      now,
      now,
      now,
    );
  }

  if (isNew) {
    recordAuditEvent(db, {
      userId: options.installedByUserId,
      eventType: "slack.installed",
      requestId: options.requestId ?? null,
      metadata: {
        slack_team_id: options.slackTeamId,
        slack_team_name: options.slackTeamName,
        reflect_team_id: options.reflectTeamId,
        reflect_user_id: options.reflectUserId,
      },
    });
  }

  const row = db
    .prepare(`SELECT * FROM slack_workspaces WHERE id = ?`)
    .get(workspaceId) as SlackWorkspaceRow;
  return rowToWorkspace(row);
}

/**
 * Returns the active (not uninstalled) workspace bound to the given Reflect
 * team, or null. Multiple workspaces can map to the same team historically
 * (re-installs); this returns only the currently active one.
 */
export function getActiveWorkspaceForTeam(
  db: Database.Database,
  reflectTeamId: string,
): SlackWorkspace | null {
  const row = db
    .prepare(
      `SELECT * FROM slack_workspaces
       WHERE reflect_team_id = ? AND uninstalled_at IS NULL
       ORDER BY installed_at DESC LIMIT 1`,
    )
    .get(reflectTeamId) as SlackWorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

/**
 * Returns the active workspace bound to the given solo Reflect user.
 */
export function getActiveWorkspaceForUser(
  db: Database.Database,
  reflectUserId: string,
): SlackWorkspace | null {
  const row = db
    .prepare(
      `SELECT * FROM slack_workspaces
       WHERE reflect_user_id = ? AND uninstalled_at IS NULL
       ORDER BY installed_at DESC LIMIT 1`,
    )
    .get(reflectUserId) as SlackWorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

/**
 * Looks up a workspace by Slack's team ID (T0123…). Returns the active row,
 * or any row if includeUninstalled is true.
 */
export function getWorkspaceBySlackTeamId(
  db: Database.Database,
  slackTeamId: string,
  options: { includeUninstalled?: boolean } = {},
): SlackWorkspace | null {
  const row = (
    options.includeUninstalled
      ? db.prepare(`SELECT * FROM slack_workspaces WHERE slack_team_id = ?`).get(slackTeamId)
      : db
          .prepare(
            `SELECT * FROM slack_workspaces WHERE slack_team_id = ? AND uninstalled_at IS NULL`,
          )
          .get(slackTeamId)
  ) as SlackWorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

/**
 * Returns the workspace + decrypted bot token for the given Slack team.
 * Use only when actually about to call Slack — never log the result, never
 * return it to clients.
 */
export function getWorkspaceWithToken(
  db: Database.Database,
  slackTeamId: string,
): SlackWorkspaceWithToken | null {
  const row = db
    .prepare(
      `SELECT * FROM slack_workspaces WHERE slack_team_id = ? AND uninstalled_at IS NULL`,
    )
    .get(slackTeamId) as SlackWorkspaceRow | undefined;
  if (!row) return null;
  const botToken = decryptSlackBotToken(
    { ciphertext: row.bot_token_encrypted, nonce: row.bot_token_nonce },
    row.slack_team_id,
  );
  return { ...rowToWorkspace(row), botToken };
}

export interface SoftDeleteWorkspaceOptions {
  slackTeamId: string;
  actorUserId: string;
  requestId?: string | null;
}

/**
 * Marks a workspace as uninstalled. Returns true if a row was updated, false
 * if no active workspace existed.
 */
export function softDeleteWorkspace(
  db: Database.Database,
  options: SoftDeleteWorkspaceOptions,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE slack_workspaces
       SET uninstalled_at = ?, updated_at = ?
       WHERE slack_team_id = ? AND uninstalled_at IS NULL`,
    )
    .run(now, now, options.slackTeamId);
  if (result.changes === 0) return false;

  recordAuditEvent(db, {
    userId: options.actorUserId,
    eventType: "slack.uninstalled",
    requestId: options.requestId ?? null,
    metadata: { slack_team_id: options.slackTeamId },
  });
  return true;
}
