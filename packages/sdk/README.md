# reflect-memory-sdk

TypeScript client SDK for the [Reflect Memory](https://reflectmemory.com) API — persistent, searchable memory for AI agents.

Zero dependencies. Works with Node 18+ using native `fetch`.

## Installation

```bash
npm install reflect-memory-sdk
```

```bash
pnpm add reflect-memory-sdk
```

```bash
yarn add reflect-memory-sdk
```

## Quick Start

```typescript
import { ReflectMemory } from "reflect-memory-sdk";

const rm = new ReflectMemory({
  apiKey: process.env.REFLECT_API_KEY!,
});

// Write a memory
const memory = await rm.write({
  title: "Project Architecture",
  content: "We chose event sourcing with CQRS for the order service...",
  tags: ["architecture", "decisions"],
  allowedVendors: ["*"],
  memoryType: "semantic",
});

// Retrieve it later
const latest = await rm.getLatest("architecture");
console.log(latest?.title); // "Project Architecture"
```

## Configuration

```typescript
const rm = new ReflectMemory({
  apiKey: "rm_live_...",           // Required — your Reflect Memory API key
  baseUrl: "https://custom.host",  // Optional — defaults to https://api.reflectmemory.com
});
```

| Option    | Type     | Required | Default                              |
| --------- | -------- | -------- | ------------------------------------ |
| `apiKey`  | `string` | Yes      | —                                    |
| `baseUrl` | `string` | No       | `https://api.reflectmemory.com`      |

## API Reference

### `rm.write(params)`

Create a new memory.

```typescript
const memory = await rm.write({
  title: "Sprint Retrospective",
  content: "Key takeaway: we need better test coverage on the payments module.",
  tags: ["retro", "q1-2026"],
  allowedVendors: ["*"],
});

console.log(memory.id); // "b3f1a2c4-..."
```

**Parameters:**

| Field            | Type       | Required | Description                                    |
| ---------------- | ---------- | -------- | ---------------------------------------------- |
| `title`          | `string`   | Yes      | Title of the memory                            |
| `content`        | `string`   | Yes      | Full content body                              |
| `tags`           | `string[]` | No       | Tags for categorization and filtering          |
| `allowedVendors` | `string[]` | No       | Vendor allowlist — `["*"]` permits all vendors |
| `memoryType`     | `"semantic" \| "episodic" \| "procedural"` | No | Memory classification: semantic (facts/knowledge), episodic (events/decisions), procedural (workflows/patterns). Defaults to `"semantic"` |

**Returns:** `Promise<Memory>`

---

### `rm.getLatest(tag?)`

Get the most recent memory, optionally filtered by tag.

```typescript
// Most recent memory across all tags
const latest = await rm.getLatest();

// Most recent memory tagged "strategy"
const latestStrategy = await rm.getLatest("strategy");
```

**Parameters:**

| Field | Type     | Required | Description            |
| ----- | -------- | -------- | ---------------------- |
| `tag` | `string` | No       | Filter by a single tag |

**Returns:** `Promise<Memory | null>`

---

### `rm.getById(id)`

Retrieve a single memory by UUID.

```typescript
const memory = await rm.getById("b3f1a2c4-8d5e-4f6a-9b0c-1d2e3f4a5b6c");
console.log(memory.title, memory.content);
```

**Parameters:**

| Field | Type     | Required | Description               |
| ----- | -------- | -------- | ------------------------- |
| `id`  | `string` | Yes      | UUID of the memory        |

**Returns:** `Promise<Memory>`

**Throws:** `ReflectMemoryError` with status `404` if not found.

---

### `rm.browse(params?)`

Browse memory summaries with pagination. Returns lightweight objects without the `content` field — ideal for listing UIs.

```typescript
const page = await rm.browse({ limit: 50, offset: 0 });

page.memories.forEach((s) => {
  console.log(`${s.title} [${s.tags.join(", ")}]`);
});
console.log(`Total: ${page.total}, has more: ${page.has_more}`);
```

**Parameters:**

| Field    | Type     | Required | Description                     |
| -------- | -------- | -------- | ------------------------------- |
| `limit`  | `number` | No       | Maximum number of results       |
| `offset` | `number` | No       | Number of results to skip       |

**Returns:** `Promise<PaginatedResponse<MemorySummary>>`

---

### `rm.getByTag(params)`

Retrieve memories matching one or more tags.

```typescript
const result = await rm.getByTag({
  tags: ["strategy", "q1"],
  limit: 20,
  offset: 0,
});
// Use result.memories to access the memories
```

**Parameters:**

| Field    | Type       | Required | Description                     |
| -------- | ---------- | -------- | ------------------------------- |
| `tags`   | `string[]` | Yes      | Tags to filter by               |
| `limit`  | `number`   | No       | Maximum number of results       |
| `offset` | `number`   | No       | Number of results to skip       |

**Returns:** `Promise<PaginatedResponse<Memory>>`

---

### `rm.search(params)`

Search memories by text query.

```typescript
const results = await rm.search({
  query: "microservice architecture",
  limit: 10,
});

results.memories.forEach((m) => {
  console.log(m.title, m.tags);
});
```

**Parameters:**

| Field   | Type     | Required | Description                     |
| ------- | -------- | -------- | ------------------------------- |
| `query` | `string` | Yes      | Natural-language search query   |
| `limit` | `number` | No       | Maximum number of results       |

**Returns:** `Promise<PaginatedResponse<MemorySummary>>`

---

### `rm.whoami()`

Resolve the identity associated with the current API key.

```typescript
const identity = await rm.whoami();
console.log(identity.user_id, identity.email);
```

**Returns:** `Promise<Identity>`

## Memory Types

Every memory has a `memory_type` that classifies the kind of knowledge it represents. You can set this when writing a memory via the `memoryType` parameter. If omitted, it defaults to `"semantic"`.

| Type          | Description                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `semantic`    | Facts, knowledge, and reference information (e.g. architecture decisions, API specs) |
| `episodic`    | Events, decisions, and contextual experiences (e.g. meeting notes, incident reports) |
| `procedural`  | Workflows, patterns, and step-by-step processes (e.g. deployment runbooks, coding conventions) |

```typescript
await rm.write({
  title: "Deploy Runbook",
  content: "1. Run migrations  2. Deploy canary  3. Promote to prod ...",
  tags: ["ops", "deploy"],
  memoryType: "procedural",
});
```

## Error Handling

All API errors throw a `ReflectMemoryError` with structured context:

```typescript
import { ReflectMemory, ReflectMemoryError } from "reflect-memory-sdk";

const rm = new ReflectMemory({ apiKey: "rm_live_..." });

try {
  await rm.getById("nonexistent-id");
} catch (err) {
  if (err instanceof ReflectMemoryError) {
    console.error(err.status);   // 404
    console.error(err.message);  // "Memory not found"
    console.error(err.body);     // Raw response body from the API
  }
}
```

| Property  | Type      | Description                                     |
| --------- | --------- | ----------------------------------------------- |
| `status`  | `number`  | HTTP status code                                |
| `message` | `string`  | Human-readable error message                    |
| `body`    | `unknown` | Raw response body (parsed JSON when available)  |

## Types

All types are exported for use in your own code:

```typescript
import type {
  Memory,
  MemorySummary,
  PaginatedResponse,
  Identity,
  WriteMemoryParams,
  BrowseParams,
  GetByTagParams,
  SearchParams,
  ReflectMemoryOptions,
} from "reflect-memory-sdk";
```

### `PaginatedResponse`

```typescript
interface PaginatedResponse<T> {
  memories: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}
```

### `Memory`

```typescript
interface Memory {
  id: string;
  user_id: string;
  title: string;
  content: string;
  tags: string[];
  origin: string;
  allowed_vendors: string[];
  memory_type: string;
  created_at: string;
  updated_at: string;
  deleted_at?: string;
}
```

### `MemorySummary`

```typescript
interface MemorySummary {
  id: string;
  title: string;
  tags: string[];
  origin: string;
  memory_type: string;
  created_at: string;
}
```

### `Identity`

```typescript
interface Identity {
  user_id: string;
  email?: string;
  name?: string;
  [key: string]: unknown;
}
```

## Requirements

- **Node.js 18+** (uses native `fetch`)
- No external dependencies

## License

MIT — [Reflect Memory Inc](https://reflectmemory.com)
