/**
 * Obsidian Cloud MCP — Worker
 * Self-hosted Cloudflare Worker that stores your Obsidian vault in R2
 * and exposes it as an MCP endpoint for Claude.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  VAULT: DurableObjectNamespace<VaultAgent>;
  VAULT_STORAGE: R2Bucket;
  API_TOKEN: string;
}

// --- Auth ---

function timingSafeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let result = 0;
  for (let i = 0; i < bufA.length; i++) {
    result |= bufA[i] ^ bufB[i];
  }
  return result === 0;
}

function authenticate(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  if (auth && timingSafeCompare(auth, `Bearer ${env.API_TOKEN}`)) return true;
  return false;
}

// --- Helpers ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
};

function jsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

const R2_PREFIX = "vault/";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function vaultKey(path: string): string {
  const cleaned = path.replace(/^\/+/, "");
  if (/(^|[\\/])\.\.($|[\\/])/.test(cleaned)) {
    throw new Error("Invalid path: directory traversal not allowed");
  }
  return R2_PREFIX + cleaned;
}

// --- Parse frontmatter from markdown ---

function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, any> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      const key = line.slice(0, idx).trim();
      const val = line.slice(idx + 1).trim();
      fm[key] = val;
    }
  }
  return fm;
}

// --- Extract tags from markdown ---

function extractTags(content: string, frontmatter: Record<string, any> | null): string[] {
  const tags = new Set<string>();

  // From frontmatter
  if (frontmatter?.tags) {
    const fmTags = frontmatter.tags
      .replace(/[\[\]]/g, "")
      .split(",")
      .map((t: string) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    fmTags.forEach((t: string) => tags.add(t));
  }

  // Inline #tags (not inside code blocks)
  const inlineTags = content.match(/(?:^|\s)#([a-zA-Z][\w/-]*)/g);
  if (inlineTags) {
    inlineTags.forEach((t) => tags.add(t.trim().replace(/^#/, "")));
  }

  return [...tags];
}

// --- SHA-256 hash ---

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  const arr = Array.from(new Uint8Array(buffer));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ============================================
// VaultAgent — Durable Object MCP Server
// ============================================

export class VaultAgent extends McpAgent<Env> {
  server = new McpServer({
    name: "obsidian-cloud-mcp",
    version: "0.1.0",
  });

  private dbReady = false;

  // --- Forward index operations to the canonical "vault" DO ---
  // McpAgent creates per-session DOs (streamable-http:<sessionId>) with isolated SQLite.
  // All index reads/writes must route through the single "vault" DO that holds the index.

  private async indexOp(action: string, params: Record<string, any> = {}): Promise<any> {
    const id = this.env.VAULT.idFromName("vault");
    const stub = this.env.VAULT.get(id);
    const resp = await stub.fetch(new Request("http://internal/index", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...params }),
    }));
    return resp.json();
  }

  // --- Batched reindex: process N files per alarm invocation ---

  private async processReindexBatch(): Promise<{ indexed: number; hasMore: boolean }> {
    this.ensureDB();
    const cursorVal = await this.ctx.storage.get<string>("reindex_cursor");
    let totalIndexed = (await this.ctx.storage.get<number>("reindex_count")) || 0;

    const BATCH_SIZE = 50;

    const listed = await this.env.VAULT_STORAGE.list({
      prefix: R2_PREFIX,
      cursor: cursorVal || undefined,
      limit: BATCH_SIZE,
    });

    for (const obj of listed.objects) {
      const path = obj.key.replace(R2_PREFIX, "");
      const hash = obj.customMetadata?.contentHash || obj.etag;

      const content = await this.env.VAULT_STORAGE.get(obj.key);
      if (!content) continue;
      const text = await content.text();

      const frontmatter = parseFrontmatter(text);
      const fileTags = extractTags(text, frontmatter);

      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO files (path, content_hash, size_bytes, frontmatter_json, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
        path, hash, obj.size, frontmatter ? JSON.stringify(frontmatter) : null
      );

      for (const t of fileTags) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)`,
          path, t
        );
      }

      totalIndexed++;
    }

    const hasMore = !!listed.truncated;

    await this.ctx.storage.put("reindex_count", totalIndexed);

    if (hasMore && listed.cursor) {
      await this.ctx.storage.put("reindex_cursor", listed.cursor);
    } else {
      await this.ctx.storage.delete("reindex_cursor");
      await this.ctx.storage.put("reindex_active", false);
    }

    return { indexed: totalIndexed, hasMore };
  }

  async alarm() {
    const active = await this.ctx.storage.get<boolean>("reindex_active");
    if (!active) return;

    const result = await this.processReindexBatch();

    if (result.hasMore) {
      this.ctx.storage.setAlarm(Date.now() + 100);
    }
  }

  // Handle internal REST calls from the Worker (reindex trigger, status, index ops)
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/reindex" && request.method === "POST") {
      this.ensureDB();
      this.ctx.storage.sql.exec(`DELETE FROM files`);
      this.ctx.storage.sql.exec(`DELETE FROM tags`);

      await this.ctx.storage.put("reindex_active", true);
      await this.ctx.storage.put("reindex_count", 0);
      await this.ctx.storage.delete("reindex_cursor");

      const result = await this.processReindexBatch();

      if (result.hasMore) {
        this.ctx.storage.setAlarm(Date.now() + 100);
      }

      return new Response(JSON.stringify({
        ok: true,
        indexed_so_far: result.indexed,
        in_progress: result.hasMore,
        message: result.hasMore
          ? `Reindex started — ${result.indexed} files indexed, continuing in background...`
          : `Reindex complete — ${result.indexed} files indexed`,
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/acknowledge" && request.method === "POST") {
      this.ensureDB();
      this.ctx.storage.sql.exec(`DELETE FROM tombstones`);
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/tombstones") {
      this.ensureDB();
      const rows = this.ctx.storage.sql.exec(
        `SELECT path FROM tombstones`
      ).toArray() as any[];
      return new Response(JSON.stringify({
        paths: rows.map((r) => r.path),
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/reindex-status") {
      this.ensureDB();
      const active = await this.ctx.storage.get<boolean>("reindex_active");
      const count = await this.ctx.storage.get<number>("reindex_count");
      const fileCount = this.ctx.storage.sql.exec(
        `SELECT COUNT(*) as count FROM files`
      ).toArray()[0] as any;

      return new Response(JSON.stringify({
        reindex_active: !!active,
        files_processed: count || 0,
        files_in_index: fileCount?.count || 0,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // --- Index operations endpoint (used by MCP tools via indexOp()) ---
    if (url.pathname === "/index" && request.method === "POST") {
      this.ensureDB();
      const body = await request.json() as { action: string; [key: string]: any };

      switch (body.action) {
        case "stats": {
          const fileCount = this.ctx.storage.sql.exec(
            `SELECT COUNT(*) as count FROM files`
          ).toArray()[0] as any;
          const totalSize = this.ctx.storage.sql.exec(
            `SELECT COALESCE(SUM(size_bytes), 0) as total FROM files`
          ).toArray()[0] as any;
          const tagCount = this.ctx.storage.sql.exec(
            `SELECT COUNT(DISTINCT tag) as count FROM tags`
          ).toArray()[0] as any;
          const recentFile = this.ctx.storage.sql.exec(
            `SELECT path, updated_at FROM files ORDER BY updated_at DESC LIMIT 1`
          ).toArray()[0] as any;
          return Response.json({
            files: fileCount?.count || 0,
            totalSize: totalSize?.total || 0,
            uniqueTags: tagCount?.count || 0,
            lastUpdated: recentFile?.updated_at || "never",
            lastFile: recentFile?.path || "none",
          });
        }

        case "search": {
          const rows = this.ctx.storage.sql.exec(
            `SELECT path, frontmatter_json FROM files WHERE path LIKE ? ESCAPE '\\' OR frontmatter_json LIKE ? ESCAPE '\\' LIMIT ?`,
            `%${body.escapedQuery}%`, `%${body.escapedQuery}%`, body.limit || 20
          ).toArray();
          return Response.json({ rows });
        }

        case "recent": {
          const rows = this.ctx.storage.sql.exec(
            `SELECT path, size_bytes, updated_at FROM files ORDER BY updated_at DESC LIMIT ?`,
            body.limit || 20
          ).toArray();
          return Response.json({ rows });
        }

        case "tags_by_tag": {
          const rows = this.ctx.storage.sql.exec(
            `SELECT t.path FROM tags t WHERE t.tag = ? LIMIT ?`,
            body.tag, body.limit || 50
          ).toArray();
          return Response.json({ rows });
        }

        case "tags_all": {
          const rows = this.ctx.storage.sql.exec(
            `SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC LIMIT ?`,
            body.limit || 50
          ).toArray();
          return Response.json({ rows });
        }

        case "files_manifest": {
          const rows = this.ctx.storage.sql.exec(
            `SELECT path, content_hash FROM files`
          ).toArray();
          return Response.json({ rows });
        }

        case "tombstones": {
          const rows = this.ctx.storage.sql.exec(
            `SELECT path FROM tombstones`
          ).toArray();
          return Response.json({ rows });
        }

        case "status": {
          const fileCount = this.ctx.storage.sql.exec(
            `SELECT COUNT(*) as count FROM files`
          ).toArray()[0] as any;
          const tombstoneCount = this.ctx.storage.sql.exec(
            `SELECT COUNT(*) as count FROM tombstones`
          ).toArray()[0] as any;
          const reindexActive = await this.ctx.storage.get<boolean>("reindex_active");
          const reindexCount = await this.ctx.storage.get<number>("reindex_count");
          return Response.json({
            indexedFiles: fileCount?.count || 0,
            pendingDeletes: tombstoneCount?.count || 0,
            reindexActive: !!reindexActive,
            reindexCount: reindexCount || 0,
          });
        }

        case "upsert_file": {
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO files (path, content_hash, size_bytes, frontmatter_json, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))`,
            body.path, body.hash, body.sizeBytes, body.frontmatterJson
          );
          this.ctx.storage.sql.exec(`DELETE FROM tags WHERE path = ?`, body.path);
          for (const t of body.tags || []) {
            this.ctx.storage.sql.exec(
              `INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)`,
              body.path, t
            );
          }
          this.ctx.storage.sql.exec(`DELETE FROM tombstones WHERE path = ?`, body.path);
          return Response.json({ ok: true });
        }

        case "delete_file": {
          this.ctx.storage.sql.exec(`DELETE FROM files WHERE path = ?`, body.path);
          this.ctx.storage.sql.exec(`DELETE FROM tags WHERE path = ?`, body.path);
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO tombstones (path, deleted_at, deleted_by) VALUES (?, datetime('now'), 'mcp-claude')`,
            body.path
          );
          return Response.json({ ok: true });
        }

        case "move_file": {
          const row = this.ctx.storage.sql.exec(
            `SELECT content_hash, size_bytes, frontmatter_json FROM files WHERE path = ?`,
            body.fromPath
          ).toArray()[0] as any;

          if (row) {
            this.ctx.storage.sql.exec(`DELETE FROM files WHERE path = ?`, body.fromPath);
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO files (path, content_hash, size_bytes, frontmatter_json, updated_at)
               VALUES (?, ?, ?, ?, datetime('now'))`,
              body.toPath, row.content_hash, row.size_bytes, row.frontmatter_json
            );
            const existingTags = this.ctx.storage.sql.exec(
              `SELECT tag FROM tags WHERE path = ?`, body.fromPath
            ).toArray();
            this.ctx.storage.sql.exec(`DELETE FROM tags WHERE path = ?`, body.fromPath);
            for (const t of existingTags) {
              this.ctx.storage.sql.exec(
                `INSERT OR IGNORE INTO tags (path, tag) VALUES (?, ?)`,
                body.toPath, (t as any).tag
              );
            }
          }
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO tombstones (path, deleted_at, deleted_by) VALUES (?, datetime('now'), 'mcp-claude')`,
            body.fromPath
          );
          return Response.json({ ok: true });
        }

        case "clear_tombstones": {
          this.ctx.storage.sql.exec(`DELETE FROM tombstones`);
          return Response.json({ ok: true });
        }

        default:
          return Response.json({ error: `Unknown index action: ${body.action}` }, { status: 400 });
      }
    }

    // Pass everything else to McpAgent's fetch handler (MCP protocol)
    return super.fetch(request);
  }

  private ensureDB() {
    if (this.dbReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        size_bytes INTEGER,
        etag TEXT,
        frontmatter_json TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tags (
        path TEXT REFERENCES files(path) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (path, tag)
      );
      CREATE TABLE IF NOT EXISTS tombstones (
        path TEXT PRIMARY KEY,
        deleted_at TEXT DEFAULT (datetime('now')),
        deleted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
      CREATE INDEX IF NOT EXISTS idx_files_updated ON files(updated_at);
    `);
    this.dbReady = true;
  }

  async init() {
    // MCP tools forward all index operations to the canonical "vault" DO via indexOp().
    // No local ensureDB() needed — per-session DOs don't use their own SQLite.

    // ---- vault_file: read, write, delete, move ----

    this.server.tool(
      "vault_file",
      "Read, write, delete, or move files in the Obsidian vault",
      {
        action: z.enum(["read", "write", "delete", "move"]),
        path: z.string().describe("File path relative to vault root"),
        content: z.string().optional().describe("File content (for write action)"),
        destination: z.string().optional().describe("New path (for move action)"),
      },
      async ({ action, path, content, destination }) => {
        switch (action) {
          case "read": {
            const obj = await this.env.VAULT_STORAGE.get(vaultKey(path));
            if (!obj) {
              return { content: [{ type: "text" as const, text: `File not found: ${path}` }] };
            }
            const text = await obj.text();
            return { content: [{ type: "text" as const, text: text }] };
          }

          case "write": {
            if (!content) {
              return { content: [{ type: "text" as const, text: "Content is required for write action" }] };
            }
            const sizeBytes = new TextEncoder().encode(content).byteLength;
            if (sizeBytes > MAX_FILE_SIZE) {
              return { content: [{ type: "text" as const, text: `File too large: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` }] };
            }
            const hash = await hashContent(content);
            const key = vaultKey(path);

            await this.env.VAULT_STORAGE.put(key, content, {
              httpMetadata: { contentType: "text/markdown" },
              customMetadata: {
                contentHash: hash,
                clientModifiedAt: new Date().toISOString(),
                deviceId: "mcp-claude",
              },
            });

            // Update canonical vault DO index
            const frontmatter = parseFrontmatter(content);
            const tags = extractTags(content, frontmatter);
            await this.indexOp("upsert_file", {
              path, hash, sizeBytes,
              frontmatterJson: frontmatter ? JSON.stringify(frontmatter) : null,
              tags,
            });

            return { content: [{ type: "text" as const, text: `Written: ${path} (${sizeBytes} bytes)` }] };
          }

          case "delete": {
            await this.env.VAULT_STORAGE.delete(vaultKey(path));
            await this.indexOp("delete_file", { path });
            return { content: [{ type: "text" as const, text: `Deleted: ${path}` }] };
          }

          case "move": {
            if (!destination) {
              return { content: [{ type: "text" as const, text: "Destination is required for move action" }] };
            }
            const srcObj = await this.env.VAULT_STORAGE.get(vaultKey(path));
            if (!srcObj) {
              return { content: [{ type: "text" as const, text: `Source not found: ${path}` }] };
            }
            const body = await srcObj.text();

            // Copy to destination
            await this.env.VAULT_STORAGE.put(vaultKey(destination), body, {
              httpMetadata: srcObj.httpMetadata,
              customMetadata: {
                ...srcObj.customMetadata,
                clientModifiedAt: new Date().toISOString(),
              },
            });

            // Delete source
            await this.env.VAULT_STORAGE.delete(vaultKey(path));

            // Update canonical vault DO index
            await this.indexOp("move_file", { fromPath: path, toPath: destination });

            return { content: [{ type: "text" as const, text: `Moved: ${path} → ${destination}` }] };
          }
        }
      }
    );

    // ---- vault_browse: list, search, recent, tags ----

    this.server.tool(
      "vault_browse",
      "Browse the vault — list files, search content, find recent files, or filter by tag",
      {
        action: z.enum(["list", "search", "recent", "tags"]),
        folder: z.string().optional().describe("Folder path to list (for list action)"),
        query: z.string().optional().describe("Search query (for search action)"),
        tag: z.string().optional().describe("Tag to filter by (for tags action)"),
        recursive: z.boolean().optional().default(true).describe("List recursively (for list action)"),
        limit: z.number().optional().default(20).describe("Max results to return"),
      },
      async ({ action, folder, query, tag, recursive, limit }) => {
        switch (action) {
          case "list": {
            const prefix = folder ? vaultKey(folder.replace(/\/$/, "") + "/") : R2_PREFIX;
            const options: R2ListOptions = {
              prefix,
              limit: limit || 100,
              delimiter: recursive ? undefined : "/",
            };

            const listed = await this.env.VAULT_STORAGE.list(options);
            const files = listed.objects.map((o) => ({
              path: o.key.replace(R2_PREFIX, ""),
              size: o.size,
              modified: o.uploaded.toISOString(),
            }));

            const folders = (listed.delimitedPrefixes || []).map((p) =>
              p.replace(R2_PREFIX, "").replace(/\/$/, "") + "/"
            );

            const result = recursive
              ? `Files (${files.length}):\n${files.map((f) => `  ${f.path} (${f.size}b)`).join("\n")}`
              : `Folders:\n${folders.map((f) => `  ${f}`).join("\n")}\n\nFiles (${files.length}):\n${files.map((f) => `  ${f.path} (${f.size}b)`).join("\n")}`;

            return { content: [{ type: "text" as const, text: result || "Empty" }] };
          }

          case "search": {
            if (!query) {
              return { content: [{ type: "text" as const, text: "Query is required for search action" }] };
            }

            const lowerQuery = query.toLowerCase();
            const results: { path: string; snippet: string }[] = [];

            // Search file index via canonical vault DO
            const escapedQuery = query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
            const indexResult = await this.indexOp("search", { escapedQuery, limit: limit || 20 });

            for (const row of indexResult.rows || []) {
              results.push({ path: row.path, snippet: `[matched in index]` });
            }

            // If not enough results, scan R2 content
            if (results.length < (limit || 20)) {
              const listed = await this.env.VAULT_STORAGE.list({ prefix: R2_PREFIX, limit: 500 });
              for (const obj of listed.objects) {
                const path = obj.key.replace(R2_PREFIX, "");
                if (results.some((r) => r.path === path)) continue;
                if (results.length >= (limit || 20)) break;

                const content = await this.env.VAULT_STORAGE.get(obj.key);
                if (!content) continue;
                const text = await content.text();
                const lower = text.toLowerCase();
                const idx = lower.indexOf(lowerQuery);
                if (idx >= 0) {
                  const start = Math.max(0, idx - 50);
                  const end = Math.min(text.length, idx + query.length + 50);
                  results.push({ path, snippet: `...${text.slice(start, end)}...` });
                }
              }
            }

            const text = results.length
              ? results.map((r) => `${r.path}\n  ${r.snippet}`).join("\n\n")
              : `No results for "${query}"`;

            return { content: [{ type: "text" as const, text }] };
          }

          case "recent": {
            const result = await this.indexOp("recent", { limit: limit || 20 });
            const rows = result.rows || [];

            const text = rows.length
              ? rows.map((r: any) => `${r.path} (${r.size_bytes}b, ${r.updated_at})`).join("\n")
              : "No files indexed yet";

            return { content: [{ type: "text" as const, text }] };
          }

          case "tags": {
            if (tag) {
              const result = await this.indexOp("tags_by_tag", { tag, limit: limit || 50 });
              const rows = result.rows || [];

              const text = rows.length
                ? `Files tagged #${tag}:\n${rows.map((r: any) => `  ${r.path}`).join("\n")}`
                : `No files with tag #${tag}`;
              return { content: [{ type: "text" as const, text }] };
            } else {
              const result = await this.indexOp("tags_all", { limit: limit || 50 });
              const rows = result.rows || [];

              const text = rows.length
                ? rows.map((r: any) => `#${r.tag} (${r.count})`).join("\n")
                : "No tags indexed";
              return { content: [{ type: "text" as const, text }] };
            }
          }
        }
      }
    );

    // ---- vault_meta: frontmatter_read, frontmatter_update, stats ----

    this.server.tool(
      "vault_meta",
      "Read or update file frontmatter, or get vault statistics",
      {
        action: z.enum(["frontmatter_read", "frontmatter_update", "stats"]),
        path: z.string().optional().describe("File path (for frontmatter actions)"),
        updates: z.record(z.string()).optional().describe("Key-value pairs to set in frontmatter"),
      },
      async ({ action, path, updates }) => {
        switch (action) {
          case "frontmatter_read": {
            if (!path) {
              return { content: [{ type: "text" as const, text: "Path required" }] };
            }
            const obj = await this.env.VAULT_STORAGE.get(vaultKey(path));
            if (!obj) {
              return { content: [{ type: "text" as const, text: `Not found: ${path}` }] };
            }
            const text = await obj.text();
            const fm = parseFrontmatter(text);
            return {
              content: [{ type: "text" as const, text: fm ? JSON.stringify(fm, null, 2) : "No frontmatter" }],
            };
          }

          case "frontmatter_update": {
            if (!path || !updates) {
              return { content: [{ type: "text" as const, text: "Path and updates required" }] };
            }
            const obj = await this.env.VAULT_STORAGE.get(vaultKey(path));
            if (!obj) {
              return { content: [{ type: "text" as const, text: `Not found: ${path}` }] };
            }
            let text = await obj.text();
            const existing = parseFrontmatter(text);
            const merged = { ...existing, ...updates };

            // Rebuild frontmatter
            const fmLines = Object.entries(merged)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\n");
            const newFm = `---\n${fmLines}\n---`;

            if (existing) {
              text = text.replace(/^---\n[\s\S]*?\n---/, newFm);
            } else {
              text = newFm + "\n\n" + text;
            }

            // Write back
            const hash = await hashContent(text);
            const fmSizeBytes = new TextEncoder().encode(text).byteLength;
            await this.env.VAULT_STORAGE.put(vaultKey(path), text, {
              httpMetadata: { contentType: "text/markdown" },
              customMetadata: {
                contentHash: hash,
                clientModifiedAt: new Date().toISOString(),
                deviceId: "mcp-claude",
              },
            });

            // Update canonical vault DO index
            const fmTags = extractTags(text, merged);
            await this.indexOp("upsert_file", {
              path, hash, sizeBytes: fmSizeBytes,
              frontmatterJson: JSON.stringify(merged),
              tags: fmTags,
            });

            return { content: [{ type: "text" as const, text: `Frontmatter updated: ${path}` }] };
          }

          case "stats": {
            const result = await this.indexOp("stats");

            const stats = {
              files: result.files,
              total_size: `${((result.totalSize || 0) / 1024 / 1024).toFixed(2)} MB`,
              unique_tags: result.uniqueTags,
              last_updated: result.lastUpdated,
              last_file: result.lastFile,
            };

            return {
              content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }],
            };
          }
        }
      }
    );

    // ---- vault_sync: status, compare_manifest, acknowledge, reindex ----

    this.server.tool(
      "vault_sync",
      "Check sync status or manage sync state (primarily used by the Obsidian plugin)",
      {
        action: z.enum(["status", "compare_manifest", "acknowledge_sync", "reindex"]),
        manifest: z
          .record(z.string())
          .optional()
          .describe("Client manifest: { path: contentHash } mapping (for compare_manifest)"),
      },
      async ({ action, manifest }) => {
        switch (action) {
          case "status": {
            const result = await this.indexOp("status");

            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  indexed_files: result.indexedFiles,
                  pending_deletes: result.pendingDeletes,
                  reindex_in_progress: result.reindexActive,
                  ...(result.reindexActive ? { reindex_files_processed: result.reindexCount } : {}),
                  status: "ok",
                }, null, 2),
              }],
            };
          }

          case "compare_manifest": {
            if (!manifest) {
              return { content: [{ type: "text" as const, text: "Manifest required" }] };
            }

            const filesResult = await this.indexOp("files_manifest");
            const serverFiles = filesResult.rows || [];

            const serverMap = new Map(serverFiles.map((f: any) => [f.path, f.content_hash]));
            const clientPaths = new Set(Object.keys(manifest));

            const needsUpload: string[] = [];
            const needsDownload: string[] = [];
            const serverOnly: string[] = [];

            for (const [path, hash] of Object.entries(manifest)) {
              const serverHash = serverMap.get(path);
              if (!serverHash) {
                needsUpload.push(path);
              } else if (serverHash !== hash) {
                needsDownload.push(path);
              }
            }

            for (const [p] of serverMap) {
              if (!clientPaths.has(p as string)) {
                serverOnly.push(p as string);
              }
            }

            // Check tombstones
            const tombResult = await this.indexOp("tombstones");
            const tombstoneSet = new Set((tombResult.rows || []).map((t: any) => t.path));

            const deletedOnServer = needsUpload.filter((p) => tombstoneSet.has(p));
            const filteredUpload = needsUpload.filter((p) => !tombstoneSet.has(p));

            return {
              content: [{
                type: "text" as const,
                text: JSON.stringify({
                  needs_upload: filteredUpload,
                  needs_download: [...needsDownload, ...serverOnly],
                  deleted_on_server: deletedOnServer,
                }, null, 2),
              }],
            };
          }

          case "acknowledge_sync": {
            await this.indexOp("clear_tombstones");
            return { content: [{ type: "text" as const, text: "Sync acknowledged, tombstones cleared" }] };
          }

          case "reindex": {
            // Forward to the canonical vault DO (which has the SQLite index)
            const id = this.env.VAULT.idFromName("vault");
            const stub = this.env.VAULT.get(id);
            const resp = await stub.fetch(new Request("http://internal/reindex", { method: "POST" }));
            const result = await resp.json() as any;

            if (result.in_progress) {
              return {
                content: [{
                  type: "text" as const,
                  text: `Reindex started — ${result.indexed_so_far} files indexed so far, continuing in background...`,
                }],
              };
            }

            return {
              content: [{
                type: "text" as const,
                text: `Reindex complete — ${result.indexed_so_far} files indexed`,
              }],
            };
          }
        }
      }
    );
  }
}

// ============================================
// Worker entry point
// ============================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check (no auth)
    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "obsidian-cloud-mcp" });
    }

    // MCP endpoints — no auth required (URL secrecy is the auth model)
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return VaultAgent.serveSSE("/sse", { binding: "VAULT" }).fetch(request, env, ctx);
    }

    if (url.pathname === "/mcp") {
      if (request.method === "POST" && !request.headers.get("mcp-session-id")) {
        try {
          const clone = request.clone();
          const body = (await clone.json()) as any;
          const messages = Array.isArray(body) ? body : [body];
          if (messages.every((m: any) => !("id" in m))) {
            return new Response(null, { status: 202 });
          }
        } catch (_) {
          /* fall through */
        }
      }
      return VaultAgent.serve("/mcp", { binding: "VAULT" }).fetch(request, env, ctx);
    }

    // Auth check for sync API
    if (!authenticate(request, env)) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    // --- Sync API endpoints (used by Obsidian plugin) ---
    // Wrapped in try/catch for vaultKey() path traversal errors
    try {

    if (url.pathname === "/api/sync/upload" && request.method === "POST") {
      const body = (await request.json()) as { path: string; content: string; hash: string };
      const uploadSize = new TextEncoder().encode(body.content).byteLength;
      if (uploadSize > MAX_FILE_SIZE) {
        return jsonResponse({ error: `File too large: ${(uploadSize / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` }, 413);
      }
      const key = vaultKey(body.path);

      await env.VAULT_STORAGE.put(key, body.content, {
        httpMetadata: { contentType: "text/markdown" },
        customMetadata: {
          contentHash: body.hash,
          clientModifiedAt: new Date().toISOString(),
          deviceId: "obsidian-plugin",
        },
      });

      // Index updates happen via vault_sync reindex after batch sync
      return jsonResponse({ ok: true, path: body.path });
    }

    if (url.pathname === "/api/sync/delete" && request.method === "DELETE") {
      const body = (await request.json()) as { path: string };
      await env.VAULT_STORAGE.delete(vaultKey(body.path));
      return jsonResponse({ ok: true, deleted: body.path });
    }

    if (url.pathname === "/api/sync/rename" && request.method === "PATCH") {
      const body = (await request.json()) as { from: string; to: string };

      const srcObj = await env.VAULT_STORAGE.get(vaultKey(body.from));
      if (!srcObj) return jsonResponse({ error: `Not found: ${body.from}` }, 404);

      const content = await srcObj.text();
      await env.VAULT_STORAGE.put(vaultKey(body.to), content, {
        httpMetadata: srcObj.httpMetadata,
        customMetadata: {
          ...srcObj.customMetadata,
          clientModifiedAt: new Date().toISOString(),
        },
      });
      await env.VAULT_STORAGE.delete(vaultKey(body.from));

      return jsonResponse({ ok: true, from: body.from, to: body.to });
    }

    if (url.pathname === "/api/sync/manifest" && request.method === "POST") {
      const body = (await request.json()) as { manifest: Record<string, string> };

      // List all R2 objects and build server manifest
      const serverManifest: Record<string, { hash: string; size: number }> = {};
      let cursor: string | undefined;

      do {
        const listed = await env.VAULT_STORAGE.list({
          prefix: R2_PREFIX,
          cursor,
          limit: 1000,
        });

        for (const obj of listed.objects) {
          const path = obj.key.replace(R2_PREFIX, "");
          serverManifest[path] = {
            hash: obj.customMetadata?.contentHash || obj.etag,
            size: obj.size,
          };
        }

        cursor = listed.truncated ? listed.cursor : undefined;
      } while (cursor);

      // Compare
      const clientManifest = body.manifest || {};
      const needsUpload: string[] = [];
      const needsDownload: string[] = [];
      const upToDate: string[] = [];

      for (const [path, hash] of Object.entries(clientManifest)) {
        const server = serverManifest[path];
        if (!server) {
          needsUpload.push(path);
        } else if (server.hash !== hash) {
          needsDownload.push(path); // server version is different
        } else {
          upToDate.push(path);
        }
        delete serverManifest[path]; // processed
      }

      // Remaining server files = server-only (need download to client)
      const serverOnly = Object.keys(serverManifest);

      // Check tombstones from the DO to avoid re-uploading deleted files
      const doId = env.VAULT.idFromName("vault");
      const doStub = env.VAULT.get(doId);
      const tombResp = await doStub.fetch(new Request("http://internal/tombstones"));
      const tombData = (await tombResp.json()) as { paths: string[] };
      const tombstoneSet = new Set(tombData.paths);

      const deletedOnServer = needsUpload.filter((p) => tombstoneSet.has(p));
      const filteredUpload = needsUpload.filter((p) => !tombstoneSet.has(p));

      return jsonResponse({
        needs_upload: filteredUpload,
        needs_download: [...needsDownload, ...serverOnly],
        deleted_on_server: deletedOnServer,
        up_to_date: upToDate.length,
      });
    }

    if (url.pathname === "/api/sync/download" && request.method === "POST") {
      const body = (await request.json()) as { path: string };
      const obj = await env.VAULT_STORAGE.get(vaultKey(body.path));
      if (!obj) return jsonResponse({ error: "Not found" }, 404);

      const content = await obj.text();
      return jsonResponse({
        path: body.path,
        content,
        hash: obj.customMetadata?.contentHash || obj.etag,
      });
    }

    if (url.pathname === "/api/sync/status" && request.method === "GET") {
      const listed = await env.VAULT_STORAGE.list({ prefix: R2_PREFIX, limit: 1 });
      return jsonResponse({
        status: "ok",
        has_files: listed.objects.length > 0,
      });
    }

    // Acknowledge sync — clears tombstones after plugin processed them
    if (url.pathname === "/api/sync/acknowledge" && request.method === "POST") {
      const id = env.VAULT.idFromName("vault");
      const stub = env.VAULT.get(id);
      const resp = await stub.fetch(new Request("http://internal/acknowledge", { method: "POST" }));
      const result = await resp.json();
      return jsonResponse(result);
    }

    // Reindex trigger — kicks off batched reindex via the DO
    if (url.pathname === "/api/sync/reindex" && request.method === "POST") {
      const id = env.VAULT.idFromName("vault");
      const stub = env.VAULT.get(id);
      const resp = await stub.fetch(new Request("http://internal/reindex", { method: "POST" }));
      const result = await resp.json();
      return jsonResponse(result);
    }

    // Reindex status check
    if (url.pathname === "/api/sync/reindex-status" && request.method === "GET") {
      const id = env.VAULT.idFromName("vault");
      const stub = env.VAULT.get(id);
      const resp = await stub.fetch(new Request("http://internal/reindex-status"));
      const result = await resp.json();
      return jsonResponse(result);
    }

    return new Response("Obsidian Cloud MCP — your vault, everywhere.", {
      headers: { "Content-Type": "text/plain" },
    });

    } catch (e: any) {
      if (e.message?.includes("directory traversal")) {
        return jsonResponse({ error: e.message }, 400);
      }
      return jsonResponse({ error: "Internal server error" }, 500);
    }
  },
};
