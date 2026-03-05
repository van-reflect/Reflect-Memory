# n8n-nodes-reflect-memory

This is an [n8n](https://n8n.io/) community node that integrates with [Reflect Memory](https://reflectmemory.com) — a cross-agent memory layer for AI tools.

It lets you read, write, browse, and search AI memories from any n8n workflow.

[n8n](https://n8n.io/) is a [fair-code licensed](https://docs.n8n.io/reference/license/) workflow automation platform.

## Installation

Follow the [installation guide](https://docs.n8n.io/integrations/community-nodes/installation/) in the n8n community nodes documentation.

**In the n8n UI:**

1. Go to **Settings > Community Nodes**
2. Select **Install**
3. Enter `n8n-nodes-reflect-memory`
4. Agree to the risks and click **Install**

**Self-hosted (npm):**

```bash
cd ~/.n8n
npm install n8n-nodes-reflect-memory
```

## Credentials

This node requires a **Reflect Memory API** credential:

| Field | Description |
|-------|-------------|
| **API Key** | Your Reflect Memory agent API key |
| **Base URL** | API endpoint (default: `https://api.reflectmemory.com`) |

To set up credentials:

1. In n8n, go to **Credentials > Add Credential**
2. Search for **Reflect Memory API**
3. Enter your API key and (optionally) a custom base URL
4. Click **Save**

## Operations

| Operation | Description |
|-----------|-------------|
| **Get Latest** | Retrieve the most recent memory, with optional tag filter |
| **Get by ID** | Retrieve a specific memory by its UUID |
| **Browse** | Browse memory summaries with pagination (limit & offset) |
| **Get by Tag** | Get memories matching any of the given tags |
| **Write** | Create a new memory with title, content, tags, and vendor visibility |

## Usage

### Get Latest Memory

Returns the most recent memory. Optionally filter by a single tag.

### Get Memory by ID

Provide a memory UUID to retrieve its full content.

### Browse Memories

Paginate through memory summaries. Set **Limit** (1–200, default 50) and **Offset** (default 0).

### Get Memories by Tag

Provide a comma-separated list of tags. Returns memories matching any of the given tags, with pagination support.

### Write a Memory

Create a new memory with:

- **Title** — Short descriptive title
- **Content** — The memory content (supports multi-line)
- **Tags** — Comma-separated tags for categorization
- **Allowed Vendors** — Comma-separated vendor names that can access this memory, or `*` for all

## Example Workflow

1. **Schedule Trigger** — Run every hour
2. **Reflect Memory** node — Browse recent memories
3. **IF** node — Check if memories contain a specific tag
4. **Reflect Memory** node — Write a summary memory with results

## Compatibility

- Tested with n8n version 1.x
- Requires Node.js 18+

## Resources

- [Reflect Memory Documentation](https://reflectmemory.com/docs)
- [n8n Community Nodes Documentation](https://docs.n8n.io/integrations/community-nodes/)

## License

[MIT](https://github.com/van-reflect/n8n-nodes-reflect-memory/blob/main/LICENSE)
