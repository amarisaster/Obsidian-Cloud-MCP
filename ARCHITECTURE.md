# Obsidian Cloud MCP — Architecture

## Problem

Every existing Obsidian MCP is local-only (stdio transport). They require a running desktop app, terminal configuration, and the machine to be awake. No mobile access. No phone app support. If your laptop is closed, your AI can't read your vault.

## Solution

**Obsidian Cloud MCP** — An Obsidian plugin syncs your vault to Cloudflare R2. A Cloudflare Worker exposes it as an MCP endpoint. Claude reads, writes, and searches your vault from anywhere.

Self-hosted on your own Cloudflare account. Free tier covers it.

---

## Architecture

```
+------------------+        HTTPS        +----------------------------------+
|  Obsidian Plugin | -----------------> |  Cloudflare Worker               |
|  (Desktop/Mobile)|    Sync API         |  obsidian-cloud-mcp              |
+------------------+                     +----------------------------------+
                                         |  R2: vault file storage          |
                                         |  DO SQLite: file index + tags    |
                                         |  MCP: tool endpoints (SSE/HTTP)  |
                                         +----------------------------------+
                                                   |
                                              MCP (SSE / Streamable HTTP)
                                                   |
                                         +----------------------------------+
                                         |  Claude (any client)             |
                                         |  Phone / Desktop / Web / Code    |
                                         +----------------------------------+
```

### Three Components

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Obsidian Plugin | TypeScript (Obsidian API) | Syncs vault files to R2, settings UI |
| Cloud Worker | CF Worker + R2 + Durable Object (SQLite) | Stores vault, serves MCP tools |
| Claude Integration | Remote MCP Connector | Claude reads/writes vault via MCP |

### Stack

- `agents` package (`agents/mcp`) — Cloudflare's MCP agent framework
- `@modelcontextprotocol/sdk` — official MCP SDK
- `zod` — tool schema validation
- `McpAgent` extends Durable Object — provides SQLite + MCP session management
- Single-tenant: one deployment = one user = one vault

---

## Worker

### Single File Architecture

Everything lives in `worker/src/index.ts`: the VaultAgent Durable Object class, MCP tool definitions, sync REST API, and the router. Keeping it in one file avoids import complexity and makes the codebase easy to audit.

### Bindings

```toml
# wrangler.toml
name = "obsidian-cloud-mcp"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "VAULT_STORAGE"
bucket_name = "obsidian-vault"

[durable_objects]
bindings = [
  { name = "VAULT", class_name = "VaultAgent" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["VaultAgent"]
```

`nodejs_compat` is required because the `agents` package uses `AsyncLocalStorage`.

### Authentication

Two auth layers:

| Endpoint | Auth | Reason |
|----------|------|--------|
| MCP (`/sse`, `/mcp`) | None (URL is the secret) | Claude Custom Connectors can't pass headers or query params reliably. URL secrecy is the auth model. |
| Sync API (`/api/sync/*`) | Bearer token | Plugin sends `Authorization: Bearer {token}` on every request. Token is set via `wrangler secret put API_TOKEN`. |

Router order matters: CORS → health → MCP/SSE (no auth) → auth check → sync API → fallback.

### Durable Object SQLite

```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER,
  etag TEXT,
  frontmatter_json TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE tags (
  path TEXT REFERENCES files(path) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (path, tag)
);

CREATE TABLE tombstones (
  path TEXT PRIMARY KEY,
  deleted_at TEXT DEFAULT (datetime('now')),
  deleted_by TEXT
);
```

DO SQLite is co-located with the MCP handler — reads are near-instant.

### R2 Storage

```
obsidian-vault/
  vault/
    Notes/my-note.md
    Projects/project-a.md
    Daily/2026-03-10.md
```

Single-tenant — no user ID prefixes. Files map directly to vault paths under the `vault/` prefix.

Per-object metadata (via `customMetadata`):
```typescript
{
  contentHash: "abc123...",           // SHA-256, for change detection
  clientModifiedAt: "2026-03-10T14:30Z",
  deviceId: "obsidian-plugin"        // or "mcp-claude"
}
```

### MCP Tools (4 tools, action-enum pattern)

| Tool | Actions | Description |
|------|---------|-------------|
| `vault_file` | `read`, `write`, `delete`, `move` | Core file operations |
| `vault_browse` | `list`, `search`, `recent`, `tags` | Find and discover files |
| `vault_meta` | `frontmatter_read`, `frontmatter_update`, `stats` | Metadata operations |
| `vault_sync` | `status`, `compare_manifest`, `acknowledge_sync`, `reindex` | Sync management |

The action-enum pattern keeps Claude's tool panel clean — 4 tools instead of 16+.

**Search:** DO SQLite for path/frontmatter matching (fast), R2 content scan as fallback (slower, reads file bodies).

**Reindex:** Batched using DO alarms — processes 50 files per invocation to stay within Cloudflare's subrequest limits. A 1,000+ file vault indexes in ~5 seconds across multiple alarm invocations.

### Sync API (REST)

Used by the Obsidian plugin. All require Bearer token auth.

```
POST   /api/sync/upload          Upload a file to R2
POST   /api/sync/download        Download a file from R2
POST   /api/sync/manifest        Compare local vs remote file hashes
DELETE /api/sync/delete           Delete a file from R2
PATCH  /api/sync/rename           Rename a file in R2
GET    /api/sync/status           Check if vault has files
POST   /api/sync/reindex          Trigger batched index rebuild
GET    /api/sync/reindex-status   Check reindex progress
```

### MCP Endpoints

```
GET /sse                          SSE transport (Claude Custom Connectors)
POST /mcp                         Streamable HTTP transport (Claude Code)
```

---

## Obsidian Plugin

### Files

```
plugin/
  src/
    main.ts       Plugin entry — extends Plugin, file watchers, commands
    settings.ts   Settings tab UI
    sync.ts       Sync engine — hashing, manifest, upload/download
  manifest.json   Plugin metadata (isDesktopOnly: false)
```

### Sync Strategy

**Full sync:**
1. Plugin reads all syncable files, computes SHA-256 hash for each
2. Sends manifest (`{ path: hash }`) to worker
3. Worker compares against R2 metadata, returns diff
4. Plugin uploads only changed files, downloads server-only files

**Incremental sync:**
- File modify/create → debounced upload (2-second window)
- File delete → DELETE request
- File rename → PATCH request (avoids re-upload)

**Selective sync:**
- Include/exclude folder patterns in settings
- Default excludes: `.obsidian/`, `.trash/`
- File extensions: `.md`, `.txt`, `.canvas` only

### Settings UI

- Worker URL + API Token inputs
- Test Connection button (hits `/api/sync/status`)
- Auto sync toggle
- Include/exclude folder configuration
- Last sync timestamp
- MCP URL display with copy button (for Claude setup)

### Commands

- **Sync vault now** — trigger full sync
- **Full resync** — re-upload everything (useful after first install)

### Status Bar

`Cloud MCP: OK` / `Syncing...` / `Error`

---

## Claude Integration

### Custom Connectors (Phone/Desktop/Web)

Settings > Integrations > Custom Connectors > Add:
- **Name:** Obsidian Cloud
- **URL:** `https://obsidian-cloud-mcp.<you>.workers.dev/sse`

### Claude Code

Add to `~/.claude.json`:
```json
{
  "mcpServers": {
    "obsidian-cloud": {
      "type": "url",
      "url": "https://obsidian-cloud-mcp.<you>.workers.dev/mcp"
    }
  }
}
```

---

## Free Tier Budget

| Resource | Free Tier | Usage |
|----------|-----------|-------|
| Workers | 100K requests/day | Plenty for single-user |
| R2 Storage | 10 GB | ~10K markdown files |
| R2 Writes | 1M ops/month | Well within limits |
| R2 Reads | 10M ops/month | Well within limits |
| Durable Objects (SQLite) | 100 namespaces/account | Uses 1 namespace |

Workers Free plan includes Durable Objects with SQLite backend (limited to 100 namespaces per account).

---

## File Structure

```
obsidian-cloud-mcp/
  ARCHITECTURE.md        This document
  README.md              User-facing setup guide
  LICENSE                MIT
  worker/                Cloudflare Worker
    wrangler.toml        Bindings, migrations, compat flags
    package.json
    src/
      index.ts           Everything — VaultAgent DO, MCP tools, sync API, router
  plugin/                Obsidian plugin
    manifest.json        Plugin metadata
    package.json
    src/
      main.ts            Plugin entry, file watchers, commands
      settings.ts        Settings tab UI
      sync.ts            Sync engine (hash, upload, download, manifest)
```

---

## Design Decisions

1. **Single file worker** — No reason to split 800 lines across modules. Easy to audit, no import graph.

2. **Action-enum tools** — 4 tools instead of 16+. Keeps Claude's tool list clean and avoids tool count limits on some clients.

3. **MCP endpoints unauthenticated** — Claude Custom Connectors can't pass Bearer tokens. URL secrecy is the auth model. Sync API still requires Bearer token.

4. **DO SQLite for index, R2 for storage** — R2 is the source of truth for file content. DO SQLite indexes paths, hashes, frontmatter, and tags for fast queries. `reindex` rebuilds the index from R2 if they drift.

5. **Batched reindex with DO alarms** — A large vault (1000+ files) exceeds Cloudflare's per-invocation subrequest limit if you try to read every file at once. Batching 50 files per alarm invocation solves this cleanly.

6. **Plugin uses `requestUrl` from Obsidian** — Not `fetch`. Obsidian's `requestUrl` bypasses CORS and works on mobile. Critical for the plugin working on phones.

7. **SHA-256 hashing** — Both plugin and worker use SHA-256 via `crypto.subtle` for content hashing. Available in both Obsidian (browser API) and Workers runtime.
