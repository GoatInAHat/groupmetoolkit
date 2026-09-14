---
name: groupmetoolkit
description: Read-only GroupMe account tools usable from OpenClaw without a
  connected MacBook.
---

# groupmetoolkit

Explain here when an agent should reach for this tool and how to combine its operations.

<!-- tf:operations -->
## Operations

### me

Return the authenticated GroupMe profile: id, name, avatar URL, and timestamps. Phone number and email are never returned.

`groupmetoolkit me --json '<arguments>'` prints a JSON result. MCP tool `me` on server `groupmetoolkit` returns the same result as `structuredContent`.

<!-- /tf:operations -->
