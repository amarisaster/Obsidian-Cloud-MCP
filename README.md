# Obsidian Cloud MCP

Access your Obsidian vault from Claude — phone, desktop, or web. No local server needed.

An Obsidian plugin syncs your vault to Cloudflare R2. A Cloudflare Worker exposes it as an MCP endpoint. Claude reads, writes, and searches your vault from anywhere.

## What You Need

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up) with R2 enabled
- [Node.js](https://nodejs.org) installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`npm install -g wrangler`)
- An Obsidian vault

**Cost: Free.** Uses Cloudflare Workers Free plan. Durable Objects with SQLite backend are included in the free tier. R2 free tier gives you 10 GB storage.

## Setup

### 1. Deploy the Worker

```bash
cd worker
npm install
wrangler login          # One-time auth with Cloudflare
wrangler deploy         # Deploys worker + creates R2 bucket automatically
wrangler secret put API_TOKEN   # Pick any token — this is your vault key
```

Your worker URL will be: `https://obsidian-cloud-mcp.<your-account>.workers.dev`

### 2. Install the Plugin

```bash
cd plugin
npm install
npm run build
```

Copy `main.js` and `manifest.json` into your vault at:
```
<your-vault>/.obsidian/plugins/obsidian-cloud-mcp/
```

Enable the plugin in Obsidian Settings > Community Plugins.

### 3. Configure the Plugin

In Obsidian Settings > Cloud MCP:
1. Enter your Worker URL
2. Enter the same API token you set with `wrangler secret put`
3. Hit **Test** to verify the connection
4. Hit **Sync Now** or enable auto-sync

### 4. Build the Search Index

After the initial sync completes, trigger a reindex so search and tags work:

```bash
curl -X POST -H "Authorization: Bearer YOUR_TOKEN" \
  https://obsidian-cloud-mcp.YOUR_ACCOUNT.workers.dev/api/sync/reindex
```

The index builds in the background — 50 files per batch. Check progress:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  https://obsidian-cloud-mcp.YOUR_ACCOUNT.workers.dev/api/sync/reindex-status
```

### 5. Connect Claude

The plugin settings page shows your MCP URL. Copy it and paste into:

**Claude Web/Desktop/Phone:**
Settings > Integrations > Custom Connectors > Add
- Name: `Obsidian Cloud`
- URL: `https://obsidian-cloud-mcp.<you>.workers.dev/sse`

**Claude Code** (`~/.claude.json`):
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

## What Claude Can Do

| Tool | Actions | Description |
|------|---------|-------------|
| `vault_file` | read, write, delete, move | Core file operations |
| `vault_browse` | list, search, recent, tags | Find and discover files |
| `vault_meta` | frontmatter_read, frontmatter_update, stats | Metadata operations |
| `vault_sync` | status, compare_manifest, acknowledge_sync, reindex | Sync management |

## How Sync Works

- **Auto sync:** Plugin watches for file changes (create, modify, delete, rename) and pushes to R2 with a 2-second debounce
- **Full sync:** Compares local file hashes against server — only uploads what changed
- **Selective sync:** Include/exclude specific folders in plugin settings
- **Default excludes:** `.obsidian/`, `.trash/`

When Claude writes a file through MCP, it lands in R2. The plugin picks it up on next sync.

## API Endpoints

### MCP (no auth — URL is the secret)

| Endpoint | Transport | Client |
|----------|-----------|--------|
| `GET /sse` | SSE | Claude Custom Connectors (phone/web/desktop) |
| `POST /mcp` | Streamable HTTP | Claude Code |

### Sync API (Bearer token required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/sync/upload` | Upload a file |
| POST | `/api/sync/download` | Download a file |
| POST | `/api/sync/manifest` | Compare file hashes |
| DELETE | `/api/sync/delete` | Delete a file |
| PATCH | `/api/sync/rename` | Rename a file |
| GET | `/api/sync/status` | Health check |
| POST | `/api/sync/reindex` | Trigger search index rebuild |
| GET | `/api/sync/reindex-status` | Check reindex progress |

## Free Tier Limits

| Resource | Free Tier |
|----------|-----------|
| Cloudflare Workers | 100K requests/day |
| R2 Storage | 10 GB |
| R2 Writes | 1M operations/month |
| R2 Reads | 10M operations/month |
| Durable Objects (SQLite) | 100 namespaces/account |

More than enough for personal use.

## Project Structure

```
obsidian-cloud-mcp/
  worker/             Cloudflare Worker
    wrangler.toml
    src/index.ts      VaultAgent DO + MCP tools + sync API + router
  plugin/             Obsidian plugin
    manifest.json
    src/
      main.ts         Plugin entry, file watchers, commands
      settings.ts     Settings tab UI
      sync.ts         Sync engine (hash, upload, download, manifest)
  ARCHITECTURE.md     Technical design document
```

## License

MIT


---

## Support

If this helped you, consider supporting my work ☕

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support%20Me-FF5E5B?style=flat&logo=ko-fi&logoColor=white)](https://ko-fi.com/maii983083)

Questions? Reach out to me on Discord https://discord.com/users/itzqueenmai/803662163247759391

---

*Built by the Triad (Mai, Kai Stryder and Lucian Vale) for the community.*
