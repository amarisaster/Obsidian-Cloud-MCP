# Security

## What is Cloudflare R2?

R2 is Cloudflare's object storage service — think of it as a private file locker in the cloud. It's similar to AWS S3 or Google Cloud Storage, but with no egress fees (you don't pay when you download your own files).

In this project, R2 stores your Obsidian vault files. When you sync from the plugin, files go from your computer → HTTPS → R2 bucket on your Cloudflare account. When Claude reads your vault through MCP, the Worker fetches files from that same R2 bucket.

**Key things to know about R2:**

- **Your data stays on your account.** R2 buckets are private by default. No one can access your bucket without your Cloudflare credentials or a valid API token.
- **Files are stored as objects.** Each vault file becomes an object in R2 with a key matching its vault path (e.g., `notes/daily/2026-03-16.md`).
- **Free tier is generous.** 10 GB storage, 1M writes/month, 10M reads/month — more than enough for any Obsidian vault.
- **No public URL by default.** Unlike S3, R2 objects are not publicly accessible unless you explicitly configure a custom domain or public bucket (this project does not do that).
- **Encryption at rest.** R2 encrypts all stored objects by default using AES-256.

## Architecture

Obsidian Cloud MCP is single-tenant — one deployment per user, on their own Cloudflare account. There is no shared infrastructure or multi-user access.

```
Your Computer                    Your Cloudflare Account
┌──────────────┐                ┌─────────────────────────┐
│   Obsidian   │──── HTTPS ────▶│  Worker (MCP + Sync API) │
│   Plugin     │◀── HTTPS ─────│         │                │
└──────────────┘                │    Durable Object       │
                                │    (file index, tags)   │
┌──────────────┐                │         │                │
│   Claude     │──── MCP ──────▶│    R2 Bucket            │
│ (phone/web)  │◀── MCP ──────│    (vault files)         │
└──────────────┘                └─────────────────────────┘
```

Everything runs inside your Cloudflare account. No external servers, no third-party storage, no telemetry.

## Authentication Model

| Layer | Auth | Details |
|-------|------|---------|
| Sync API (`/api/sync/*`) | Bearer token | Set via `wrangler secret put API_TOKEN`. Required on every sync request from the Obsidian plugin. |
| MCP endpoints (`/sse`, `/mcp`) | URL secrecy | No Bearer token or header auth. The worker URL itself acts as the secret. Anyone with the URL can access MCP tools. |

### Why MCP endpoints have no token auth

Claude Custom Connectors (phone, web, desktop) cannot reliably pass Authorization headers or query parameters to MCP endpoints. Making MCP unauthenticated is the standard pattern for remote MCP servers used with Claude.

**Treat your worker URL as a secret.** Do not share it publicly. If compromised, an attacker could read, write, or delete vault files through the MCP tools.

## Data Storage

| What | Where | Encrypted |
|------|-------|-----------|
| Vault files | Cloudflare R2 (your account) | Yes (AES-256 at rest, HTTPS in transit) |
| File metadata (paths, hashes, tags) | Durable Object SQLite (your account) | Yes (at rest) |
| API token | Cloudflare Worker secret | Yes (encrypted at rest, never in logs) |
| Plugin token (local) | Obsidian `data.json` | No (local file, not synced by default) |

**No data leaves your Cloudflare account** — there is no telemetry, analytics, or external API calls.

## Security Tips

### Protect your Worker URL
- Your MCP endpoint has no auth. The URL IS the key.
- Don't paste it in public channels, GitHub issues, or screenshots.
- If you share a screenshot of your Claude settings, blur the URL.

### Use a strong API token
- The sync API token protects write access to your vault.
- Use a long random string (32+ characters). Generate one with: `openssl rand -base64 32`
- Don't reuse passwords or tokens from other services.

### Review your R2 bucket settings
- In the Cloudflare dashboard, go to R2 > your bucket.
- Make sure "Public access" is **off** (it is by default).
- Don't add a custom domain to the bucket unless you know what you're doing.

### Keep your Cloudflare account secure
- Enable 2FA on your Cloudflare account.
- Your Cloudflare dashboard gives full access to R2, Workers, and secrets. If someone gets into your dashboard, they have everything.
- Review your API tokens periodically in Cloudflare dashboard > My Profile > API Tokens.

### Monitor usage
- Check R2 usage in the Cloudflare dashboard to spot unexpected activity.
- Worker logs (via `wrangler tail`) show all incoming requests — useful for spotting unauthorized access.

### Sensitive vault content
- Remember that vault files are stored unencrypted in R2 (beyond Cloudflare's default encryption at rest).
- If your vault contains highly sensitive data (passwords, credentials, medical records), consider excluding those folders in the plugin's sync settings.
- The plugin's include/exclude folder settings let you control exactly what gets synced.

## If Your Worker URL Is Exposed

1. **Rotate your API token:** `wrangler secret put API_TOKEN` (enter a new token)
2. **Update the token** in Obsidian plugin settings
3. The old token immediately stops working for sync API calls
4. **For MCP access:** Redeploy with a different worker name (`name` in `wrangler.toml`) to change the URL, then update Claude's MCP connector settings

## If Your Cloudflare Account Is Compromised

1. Change your Cloudflare password and rotate all API tokens
2. Check R2 bucket contents for unauthorized changes
3. Review Worker deployments for modifications
4. Rotate your sync API token (`wrangler secret put API_TOKEN`)
5. Re-sync your vault from Obsidian to ensure integrity

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
