export type MemoryType = "semantic" | "episodic" | "procedural";

export interface Memory {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string[];
  origin: string;
  allowed_vendors: string[];
  memory_type: MemoryType;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}

export interface MemorySummary {
  id: string;
  title: string;
  tags: string[];
  origin: string;
  memory_type: MemoryType;
  created_at: string;
}

export interface Identity {
  user_id: string;
  email?: string;
  name?: string;
}

/** Options for constructing a {@link ReflectMemory} client. */
export interface ReflectMemoryOptions {
  /** API key used for Bearer token authentication. */
  apiKey: string;
  /** Base URL of the Reflect Memory API. Defaults to `https://api.reflectmemory.com`. */
  baseUrl?: string;
}

/** Parameters for creating a new memory via {@link ReflectMemory.write}. */
export interface WriteMemoryParams {
  title: string;
  content: string;
  tags?: string[];
  /** Vendor allowlist. Pass `["*"]` to allow all vendors. */
  allowedVendors?: string[];
  /** Memory classification: semantic (facts/knowledge), episodic (events/decisions), procedural (workflows/patterns). */
  memoryType?: "semantic" | "episodic" | "procedural";
}

/** Parameters for browsing memory summaries via {@link ReflectMemory.browse}. */
export interface BrowseParams {
  limit?: number;
  offset?: number;
}

/** Parameters for fetching memories by tag via {@link ReflectMemory.getByTag}. */
export interface GetByTagParams {
  tags: string[];
  limit?: number;
  offset?: number;
}

/** Parameters for searching memories via {@link ReflectMemory.search}. */
export interface SearchParams {
  query: string;
  limit?: number;
}

/** Paginated response wrapper returned by browse, search, and getByTag. */
export interface PaginatedResponse<T> {
  memories: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
