---
description: Write a new memory to Reflect Memory
---

The user wants to write a memory. Use the `write_memory` tool.

If the user provided a title, content, and tags, use them directly. If they gave you unstructured text, organize it into a clear title and structured content, and suggest appropriate tags.

Default `allowed_vendors` to `["*"]` unless the user specifies otherwise.

After writing, confirm the memory was created and show its ID.
