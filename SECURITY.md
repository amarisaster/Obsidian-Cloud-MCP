# Security

## Architecture

Obsidian Cloud MCP is single-tenant — one deployment per user, on their own Cloudflare account. There is no shared infrastructure or multi-user access.

### Authentication Model

| Layer | Auth | Details |
|-------|------|---------|
| Sync API (`/api/sync/*`) | Bearer token | Set via `wrangler secret put API_TOKEN`. Required on every sync request from the Obsidian plugin. |
| MCP endpoints (`/sse`, `/mcp`) | URL secrecy | No Bearer token or header auth. The worker URL itself acts as the secret. Anyone with the URL can access MCP tools. |

### Why MCP endpoints have no token auth

Claude Custom Connectors (phone, web, desktop) cannot reliably pass Authorization headers or query parameters to MCP endpoints. Making MCP unauthenticated is the standard pattern for remote MCP servers used with Claude.

**Treat your worker URL as a secret.** Do not share it publicly. If compromised, an attacker could read, write, or delete vault files through the MCP tools.

### Data Storage

- **Vault files** are stored in Cloudflare R2 on your account
- **File metadata** (paths, hashes, tags) is stored in a Durable Object SQLite database on your account
- **API token** is stored as a Cloudflare Worker secret (encrypted at rest, never exposed in logs or responses)
- **No data leaves your Cloudflare account** — there is no telemetry, analytics, or external API calls

### Token Handling

- The plugin stores the API token in Obsidian's local plugin data (`data.json`), which is not synced by default
- The token is sent over HTTPS in the `Authorization` header on every sync request
- The worker validates the token on every sync API request and returns 401 on mismatch

## If Your Worker URL Is Exposed

1. Rotate your API token: `wrangler secret put API_TOKEN` (enter a new token)
2. Update the token in Obsidian plugin settings
3. The old token immediately stops working for sync API calls
4. For MCP access: redeploy with a different worker name (`name` in `wrangler.toml`) to change the URL, then update Claude's MCP connector settings

## Reporting Vulnerabilities

If you find a security issue, please report it privately:

- Open a [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository
- Or email the maintainer directly

Do not open a public issue for security vulnerabilities.

## Scope

This project does not handle:
- User authentication or accounts (single-tenant, no users)
- Payment or billing
- Personal data beyond what you put in your vault

The security boundary is your Cloudflare account. If someone has access to your Cloudflare dashboard, they have access to your vault data regardless of this project.
