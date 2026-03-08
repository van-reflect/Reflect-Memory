import { ReflectMemoryError } from "./errors.js";
import type {
  BrowseParams,
  GetByTagParams,
  Identity,
  Memory,
  MemorySummary,
  PaginatedResponse,
  ReflectMemoryOptions,
  SearchParams,
  WriteMemoryParams,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.reflectmemory.com";

/**
 * TypeScript client for the Reflect Memory API.
 *
 * Provides typed methods for creating, retrieving, browsing, and searching
 * memories stored in Reflect Memory. Uses native `fetch` -- no external
 * HTTP dependencies required (Node 18+).
 *
 * @example
 * ```ts
 * import { ReflectMemory } from "reflect-memory-sdk";
 *
 * const rm = new ReflectMemory({ apiKey: process.env.REFLECT_API_KEY! });
 * const latest = await rm.getLatest();
 * ```
 */
export class ReflectMemory {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: ReflectMemoryOptions) {
    if (!options.apiKey) {
      throw new Error("ReflectMemory requires an apiKey");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers(),
    };

    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        parsed = await res.text().catch(() => null);
      }

      const msg =
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof (parsed as Record<string, unknown>).message === "string"
          ? (parsed as Record<string, string>).message
          : `Reflect Memory API error (${res.status})`;

      throw new ReflectMemoryError(res.status, msg, parsed);
    }

    return (await res.json()) as T;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Retrieve the most recent memory, optionally filtered by tag.
   *
   * @param tag - If provided, only memories with this tag are considered.
   * @returns The most recent {@link Memory}, or `null` if none exist.
   *
   * @example
   * ```ts
   * const latest = await rm.getLatest();
   * const latestStrategy = await rm.getLatest("strategy");
   * ```
   */
  async getLatest(tag?: string): Promise<Memory | null> {
    const params = tag ? `?tag=${encodeURIComponent(tag)}` : "";
    return this.request<Memory | null>(
      "GET",
      `/agent/memories/latest${params}`,
    );
  }

  /**
   * Retrieve a single memory by its UUID.
   *
   * @param id - The UUID of the memory to retrieve.
   * @returns The matching {@link Memory}.
   * @throws {@link ReflectMemoryError} if the memory is not found (404).
   *
   * @example
   * ```ts
   * const memory = await rm.getById("b3f1a2c4-...");
   * console.log(memory.title, memory.content);
   * ```
   */
  async getById(id: string): Promise<Memory> {
    return this.request<Memory>("GET", `/agent/memories/${encodeURIComponent(id)}`);
  }

  /**
   * Create a new memory.
   *
   * @param params - The memory payload (title, content, tags, allowedVendors).
   * @returns The newly created {@link Memory}.
   *
   * @example
   * ```ts
   * const memory = await rm.write({
   *   title: "Architecture Decision",
   *   content: "We chose event sourcing for ...",
   *   tags: ["architecture", "decisions"],
   *   allowedVendors: ["*"],
   * });
   * ```
   */
  async write(params: WriteMemoryParams): Promise<Memory> {
    const body: Record<string, unknown> = {
      title: params.title,
      content: params.content,
      tags: params.tags ?? [],
      allowed_vendors: params.allowedVendors ?? ["*"],
    };
    if (params.memoryType !== undefined) {
      body.memory_type = params.memoryType;
    }
    return this.request<Memory>("POST", "/agent/memories", body);
  }

  /**
   * Browse memory summaries with pagination.
   *
   * Returns lightweight {@link MemorySummary} objects (no `content` field)
   * suitable for listing UIs and table views.
   *
   * @param params - Pagination options (`limit`, `offset`).
   * @returns A {@link PaginatedResponse} containing {@link MemorySummary} objects.
   *
   * @example
   * ```ts
   * const page = await rm.browse({ limit: 50, offset: 0 });
   * page.memories.forEach((s) => console.log(s.title));
   * console.log(`${page.total} total, has_more: ${page.has_more}`);
   * ```
   */
  async browse(params: BrowseParams = {}): Promise<PaginatedResponse<MemorySummary>> {
    return this.request<PaginatedResponse<MemorySummary>>("POST", "/agent/memories/browse", {
      filter: { by: "all" },
      limit: params.limit,
      offset: params.offset,
    });
  }

  /**
   * Retrieve memories matching one or more tags.
   *
   * @param params - Tags to filter by, plus optional pagination.
   * @returns A {@link PaginatedResponse} containing matching {@link Memory} objects.
   *
   * @example
   * ```ts
   * const tagged = await rm.getByTag({
   *   tags: ["strategy", "q1"],
   *   limit: 20,
   * });
   * tagged.memories.forEach((m) => console.log(m.title));
   * ```
   */
  async getByTag(params: GetByTagParams): Promise<PaginatedResponse<Memory>> {
    return this.request<PaginatedResponse<Memory>>("POST", "/agent/memories/by-tag", {
      tags: params.tags,
      limit: params.limit,
      offset: params.offset,
    });
  }

  /**
   * Search memories by text query.
   *
   * Uses the browse endpoint with a search filter under the hood.
   *
   * @param params - The search query string and optional result limit.
   * @returns A {@link PaginatedResponse} containing matching {@link MemorySummary} objects.
   *
   * @example
   * ```ts
   * const results = await rm.search({
   *   query: "microservice architecture",
   *   limit: 10,
   * });
   * results.memories.forEach((m) => console.log(m.title));
   * ```
   */
  async search(params: SearchParams): Promise<PaginatedResponse<MemorySummary>> {
    return this.request<PaginatedResponse<MemorySummary>>("POST", "/agent/memories/browse", {
      filter: { by: "search", term: params.query },
      limit: params.limit,
    });
  }

  /**
   * Resolve the identity associated with the current API key.
   *
   * @returns An {@link Identity} object with user details.
   *
   * @example
   * ```ts
   * const me = await rm.whoami();
   * console.log(me.user_id, me.email);
   * ```
   */
  async whoami(): Promise<Identity> {
    return this.request<Identity>("GET", "/whoami");
  }
}
