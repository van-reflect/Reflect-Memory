// In-memory, single-process event broker for Server-Sent Events.
//
// Design:
//   - One channel per user_id plus one per org_id.
//   - Publishers call emit({ userId?, orgId? }, event). Any subscriber who
//     matches either scope receives it. A subscriber subscribes to exactly one
//     userId and at most one orgId (their own).
//   - Delivery is fire-and-forget, best-effort, within-process only. We don't
//     persist events or attempt delivery across restarts. Dashboards fall back
//     to periodic polling if the stream drops.
//
// Scaling note:
//   - This works for single-process deploys (current rm01 footprint — one
//     fastify instance per env). If we ever go multi-instance, replace this
//     with a pub/sub backend (Redis, NATS) and make `emit` write there.
//   - The public EventBroker interface is designed so that swap is a drop-in.

export type MemoryEventType =
  | "memory.created"
  | "memory.updated"
  | "memory.deleted"
  | "memory.restored"
  | "memory.purged"
  | "memory.shared"
  | "memory.unshared";

export interface MemoryEvent {
  type: MemoryEventType;
  /** Memory ID; on bulk purge (empty trash) we emit one event per memory. */
  memory_id: string;
  /** Owner of the memory. */
  user_id: string;
  /** Org this event is relevant to (set for org-scoped share/unshare). */
  org_id?: string | null;
  /** Sub-team this event is relevant to (set for team-scoped share/unshare). */
  team_id?: string | null;
  /** Freshly-fetched memory row if still retrievable; null when hard-deleted. */
  memory?: unknown;
  /** ISO8601 wall clock on the server. */
  emitted_at: string;
}

export interface EventClient {
  /** Caller-supplied writer; the broker just hands events to it. */
  send: (event: MemoryEvent) => void;
  /** Caller-supplied teardown for when the broker or the client disconnects. */
  close: () => void;
}

export interface SubscribeScope {
  userId: string;
  orgId?: string | null;
}

export interface EmitScope {
  userId: string;
  orgId?: string | null;
}

export class EventBroker {
  private readonly userChannels = new Map<string, Set<EventClient>>();
  private readonly teamChannels = new Map<string, Set<EventClient>>();
  private shuttingDown = false;

  /**
   * Register a client. Returns an unsubscribe function. Safe to call twice
   * (idempotent unsubscribe).
   */
  subscribe(scope: SubscribeScope, client: EventClient): () => void {
    if (this.shuttingDown) {
      client.close();
      return () => undefined;
    }

    const userSet = this.userChannels.get(scope.userId) ?? new Set<EventClient>();
    userSet.add(client);
    this.userChannels.set(scope.userId, userSet);

    let teamSet: Set<EventClient> | null = null;
    if (scope.orgId) {
      teamSet = this.teamChannels.get(scope.orgId) ?? new Set<EventClient>();
      teamSet.add(client);
      this.teamChannels.set(scope.orgId, teamSet);
    }

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      userSet.delete(client);
      if (userSet.size === 0) this.userChannels.delete(scope.userId);
      if (teamSet && scope.orgId) {
        teamSet.delete(client);
        if (teamSet.size === 0) this.teamChannels.delete(scope.orgId);
      }
    };
  }

  /**
   * Broadcast to all clients subscribed to the user and/or team in scope.
   * De-duplicates clients subscribed to both.
   */
  emit(scope: EmitScope, event: MemoryEvent): void {
    if (this.shuttingDown) return;

    const recipients = new Set<EventClient>();
    const userSet = this.userChannels.get(scope.userId);
    if (userSet) for (const c of userSet) recipients.add(c);
    if (scope.orgId) {
      const teamSet = this.teamChannels.get(scope.orgId);
      if (teamSet) for (const c of teamSet) recipients.add(c);
    }

    for (const c of recipients) {
      try {
        c.send(event);
      } catch {
        // One misbehaving client shouldn't bring down fan-out for others.
        // The transport layer (SSE route) owns reconnect semantics.
      }
    }
  }

  /** For tests + graceful shutdown. */
  clientCount(): number {
    const all = new Set<EventClient>();
    for (const s of this.userChannels.values()) for (const c of s) all.add(c);
    for (const s of this.teamChannels.values()) for (const c of s) all.add(c);
    return all.size;
  }

  shutdown(): void {
    this.shuttingDown = true;
    const all = new Set<EventClient>();
    for (const s of this.userChannels.values()) for (const c of s) all.add(c);
    for (const s of this.teamChannels.values()) for (const c of s) all.add(c);
    this.userChannels.clear();
    this.teamChannels.clear();
    for (const c of all) {
      try {
        c.close();
      } catch {
        // Best effort.
      }
    }
  }
}
