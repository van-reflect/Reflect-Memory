/**
 * Seed script for Team demo testing.
 * Creates a test team "Acme AI Lab" with:
 * - Admin: Van's account (team_role: owner)
 * - Member 1: alex.chen@demo.reflectmemory.com
 * - Member 2: jordan.patel@demo.reflectmemory.com
 * - 15 realistic memories (mix of personal + shared)
 * - Pending invites for testing
 *
 * Usage: npx tsx scripts/seed-team-demo.ts
 * Requires: RM_OWNER_EMAIL env var set, DB_PATH pointing to the SQLite file
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const DB_PATH = process.env.DB_PATH ?? "./data/reflect-memory.db";
const OWNER_EMAIL = process.env.RM_OWNER_EMAIL ?? "van@reflectmemory.com";

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const now = new Date().toISOString();

function ensureUser(email: string, firstName: string, lastName: string): string {
  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email) as { id: string } | undefined;
  if (existing) {
    db.prepare(`UPDATE users SET first_name = ?, last_name = ?, updated_at = ? WHERE id = ?`)
      .run(firstName, lastName, now, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO users (id, email, role, plan, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, 'user', 'team', ?, ?, ?, ?)`,
  ).run(id, email, firstName, lastName, now, now);
  return id;
}

function createMemory(
  userId: string,
  title: string,
  content: string,
  tags: string[],
  origin: string,
  sharedTeamId: string | null,
): string {
  const id = randomUUID();
  const sharedAt = sharedTeamId ? now : null;
  db.prepare(
    `INSERT INTO memories (id, user_id, title, content, tags, origin, allowed_vendors, memory_type, created_at, updated_at, shared_with_team_id, shared_at)
     VALUES (?, ?, ?, ?, ?, ?, '["*"]', 'semantic', ?, ?, ?, ?)`,
  ).run(id, userId, title, content, JSON.stringify(tags), origin, now, now, sharedTeamId, sharedAt);
  return id;
}

const txn = db.transaction(() => {
  // 1. Create team
  const teamId = randomUUID();
  const ownerId = ensureUser(OWNER_EMAIL, "Van", "Mendoza");

  const existingTeam = db.prepare(`SELECT id FROM teams WHERE owner_id = ?`).get(ownerId) as { id: string } | undefined;
  if (existingTeam) {
    console.log(`[seed] Team already exists for owner ${OWNER_EMAIL} (${existingTeam.id}). Skipping.`);
    return;
  }

  db.prepare(
    `INSERT INTO teams (id, name, owner_id, plan, created_at, updated_at)
     VALUES (?, 'Acme AI Lab', ?, 'team', ?, ?)`,
  ).run(teamId, ownerId, now, now);

  // Link owner to team
  db.prepare(`UPDATE users SET team_id = ?, team_role = 'owner', plan = 'team', updated_at = ? WHERE id = ?`)
    .run(teamId, now, ownerId);

  // 2. Create members
  const alexId = ensureUser("alex.chen@demo.reflectmemory.com", "Alex", "Chen");
  db.prepare(`UPDATE users SET team_id = ?, team_role = 'member', plan = 'team', updated_at = ? WHERE id = ?`)
    .run(teamId, now, alexId);

  const jordanId = ensureUser("jordan.patel@demo.reflectmemory.com", "Jordan", "Patel");
  db.prepare(`UPDATE users SET team_id = ?, team_role = 'member', plan = 'team', updated_at = ? WHERE id = ?`)
    .run(teamId, now, jordanId);

  // 3. Seed memories -- mix of personal and shared
  // Van's memories
  createMemory(ownerId, "Our tech stack", "We use Next.js 15 with App Router, Tailwind CSS, and TypeScript. Backend is Fastify with better-sqlite3. Deploy to Vercel (frontend) and Railway (backend).", ["tech-stack", "conventions"], "user", teamId);
  createMemory(ownerId, "API authentication flow", "All API requests require a bearer token. Dashboard uses Clerk for auth, then exchanges for a backend session. MCP tools use API keys generated from the dashboard.", ["auth", "api"], "cursor", teamId);
  createMemory(ownerId, "Stripe integration notes", "We use Stripe for billing. Free/Pro/Team tiers. Webhook handles checkout.session.completed, subscription.updated, subscription.deleted. Price IDs stored as env vars.", ["billing", "stripe"], "user", teamId);
  createMemory(ownerId, "Personal: Van's daily standup format", "I prefer async standups. Post in #standups by 10am: what I did yesterday, what I'm doing today, any blockers.", ["personal", "workflow"], "user", null);
  createMemory(ownerId, "Database migration pattern", "Migrations are numbered sequentially (001_, 002_, etc.) in src/index.ts. Each checks _migrations table before running. Use db.exec() for DDL, db.prepare() for DML.", ["database", "conventions"], "cursor", teamId);

  // Alex's memories
  createMemory(alexId, "Frontend component patterns", "We use shadcn/ui components with Tailwind. Glass morphism effects via glass-1 through glass-4 classes. All components in /components, pages in /app. Use 'use client' for interactive components.", ["frontend", "conventions"], "cursor", teamId);
  createMemory(alexId, "Testing approach", "Unit tests with vitest for backend services. No e2e framework yet -- manual QA for now. Each build has a QA gate where Van tests manually.", ["testing", "process"], "user", teamId);
  createMemory(alexId, "Personal: Alex's preferred code review style", "I like small PRs with clear descriptions. Prefer async reviews. Use conventional commits.", ["personal", "workflow"], "user", null);
  createMemory(alexId, "MCP integration details", "Reflect Memory exposes an MCP server for AI tools. Tools: write_memory, read_memories, search_memories, delete_memory. Each tool requires an API key.", ["mcp", "integrations"], "claude", teamId);
  createMemory(alexId, "Error handling conventions", "Backend: throw Error with message, Fastify schema validation handles 400s. Frontend: try/catch with setError state. Never swallow errors silently.", ["conventions", "error-handling"], "cursor", null);

  // Jordan's memories
  createMemory(jordanId, "Deployment process", "Backend deploys to Railway via git push. Frontend deploys to Vercel automatically on main branch push. Environment variables managed in each platform's dashboard.", ["deployment", "devops"], "user", teamId);
  createMemory(jordanId, "Memory model design", "Memories have: title, content, tags, origin, allowed_vendors, memory_type (semantic/episodic/procedural). Soft delete with deleted_at. Versions tracked in memory_versions table.", ["data-model", "architecture"], "cursor", teamId);
  createMemory(jordanId, "Personal: Jordan's debugging approach", "When debugging, I start with the error message, check the request/response cycle, then trace through the service layer. I use console.log liberally and clean up after.", ["personal", "debugging"], "user", null);
  createMemory(jordanId, "Rate limiting strategy", "Backend uses @fastify/rate-limit. Default 100 req/min for reads, 30/min for writes, 5/min for billing actions. Dashboard API routes have their own rate limits via lib/rate-limit.ts.", ["security", "api"], "user", teamId);
  createMemory(jordanId, "Team feature architecture", "Team tier uses dual namespace: personal memories + shared team pool. Users explicitly share via 'Share to Team'. Team quota counts all members' memories against 10k limit.", ["architecture", "team"], "cursor", teamId);

  // 4. Seed pending invites
  const inviteToken1 = randomUUID();
  const inviteToken2 = randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    `INSERT INTO team_invites (id, team_id, email, token, invited_by, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(randomUUID(), teamId, "sam.rivera@demo.reflectmemory.com", inviteToken1, ownerId, now, expiresAt);

  db.prepare(
    `INSERT INTO team_invites (id, team_id, email, token, invited_by, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(randomUUID(), teamId, "casey.kim@demo.reflectmemory.com", inviteToken2, ownerId, now, expiresAt);

  console.log("[seed] Created team 'Acme AI Lab'");
  console.log(`[seed] Team ID: ${teamId}`);
  console.log(`[seed] Owner: ${OWNER_EMAIL} (${ownerId})`);
  console.log(`[seed] Member: alex.chen@demo.reflectmemory.com (${alexId})`);
  console.log(`[seed] Member: jordan.patel@demo.reflectmemory.com (${jordanId})`);
  console.log(`[seed] Created 15 memories (12 shared, 3 personal)`);
  console.log(`[seed] Created 2 pending invites`);
  console.log(`[seed] Invite token 1: ${inviteToken1}`);
  console.log(`[seed] Invite token 2: ${inviteToken2}`);
  console.log(`[seed] Join URL: https://www.reflectmemory.com/invite/${inviteToken1}`);
});

txn();
db.close();
console.log("[seed] Done.");
