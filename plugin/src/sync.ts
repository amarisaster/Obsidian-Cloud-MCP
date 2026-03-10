import { TFile, requestUrl } from "obsidian";
import type CloudMCPPlugin from "./main";

interface SyncResult {
  uploaded: number;
  downloaded: number;
  deleted: number;
  errors: string[];
}

export class VaultSync {
  private plugin: CloudMCPPlugin;

  constructor(plugin: CloudMCPPlugin) {
    this.plugin = plugin;
  }

  private get baseUrl(): string {
    return this.plugin.settings.workerUrl;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.plugin.settings.apiToken}`,
      "Content-Type": "application/json",
    };
  }

  // --- Hash ---

  private async hashContent(content: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const buffer = await crypto.subtle.digest("SHA-256", data);
    const arr = Array.from(new Uint8Array(buffer));
    return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // --- API calls ---

  private async apiCall(path: string, method: string, body?: any): Promise<any> {
    const response = await requestUrl({
      url: `${this.baseUrl}${path}`,
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      throw new Error("Invalid API token");
    }
    if (response.status >= 400) {
      throw new Error(`API error ${response.status}: ${response.text}`);
    }

    return response.json;
  }

  // --- Get syncable files ---

  private getSyncableFiles(): TFile[] {
    return this.plugin.app.vault
      .getFiles()
      .filter((f) => this.plugin.shouldSync(f));
  }

  // --- Build local manifest ---

  private async buildManifest(): Promise<Record<string, string>> {
    const files = this.getSyncableFiles();
    const manifest: Record<string, string> = {};

    for (const file of files) {
      const content = await this.plugin.app.vault.read(file);
      manifest[file.path] = await this.hashContent(content);
    }

    return manifest;
  }

  // --- Full sync (compare + upload/download) ---

  async fullSync(): Promise<SyncResult> {
    const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };

    // Build local manifest
    const manifest = await this.buildManifest();

    // Compare with server
    const diff = await this.apiCall("/api/sync/manifest", "POST", { manifest });

    // Upload files the server needs
    for (const path of diff.needs_upload || []) {
      try {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          const content = await this.plugin.app.vault.read(file);
          const hash = manifest[path];
          await this.apiCall("/api/sync/upload", "POST", { path, content, hash });
          result.uploaded++;
        }
      } catch (e: any) {
        result.errors.push(`Upload ${path}: ${e.message}`);
      }
    }

    // Delete local files that were deleted on server (via MCP)
    for (const path of diff.deleted_on_server || []) {
      try {
        const file = this.plugin.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.plugin.app.vault.delete(file);
          result.deleted++;
        }
      } catch (e: any) {
        result.errors.push(`Delete local ${path}: ${e.message}`);
      }
    }

    // Download files the client needs
    for (const path of diff.needs_download || []) {
      try {
        const response = await this.apiCall("/api/sync/download", "POST", { path });
        if (response.content) {
          const existing = this.plugin.app.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile) {
            await this.plugin.app.vault.modify(existing, response.content);
          } else {
            // Ensure parent folder exists
            const folder = path.substring(0, path.lastIndexOf("/"));
            if (folder) {
              await this.ensureFolder(folder);
            }
            await this.plugin.app.vault.create(path, response.content);
          }
          result.downloaded++;
        }
      } catch (e: any) {
        result.errors.push(`Download ${path}: ${e.message}`);
      }
    }

    // Acknowledge sync — clears tombstones on server
    if ((diff.deleted_on_server || []).length > 0) {
      try {
        await this.apiCall("/api/sync/acknowledge", "POST", {});
      } catch (_) {
        // Non-critical — tombstones are self-correcting
      }
    }

    if (result.errors.length > 0) {
      console.warn("Cloud MCP sync errors:", result.errors);
    }

    return result;
  }

  // --- Full resync (re-upload everything) ---

  async fullResync(): Promise<SyncResult> {
    const result: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, errors: [] };
    const files = this.getSyncableFiles();

    for (const file of files) {
      try {
        const content = await this.plugin.app.vault.read(file);
        const hash = await this.hashContent(content);
        await this.apiCall("/api/sync/upload", "POST", {
          path: file.path,
          content,
          hash,
        });
        result.uploaded++;
      } catch (e: any) {
        result.errors.push(`Upload ${file.path}: ${e.message}`);
      }
    }

    return result;
  }

  // --- Incremental operations ---

  async syncFile(file: TFile): Promise<void> {
    try {
      const content = await this.plugin.app.vault.read(file);
      const hash = await this.hashContent(content);
      await this.apiCall("/api/sync/upload", "POST", {
        path: file.path,
        content,
        hash,
      });
      this.plugin.updateStatusBar("idle");
    } catch (e: any) {
      console.error(`Cloud MCP: Failed to sync ${file.path}:`, e);
      this.plugin.updateStatusBar("error");
    }
  }

  async deleteRemote(path: string): Promise<void> {
    try {
      await this.apiCall("/api/sync/delete", "DELETE", { path });
    } catch (e: any) {
      console.error(`Cloud MCP: Failed to delete ${path}:`, e);
    }
  }

  async renameRemote(oldPath: string, newPath: string): Promise<void> {
    try {
      await this.apiCall("/api/sync/rename", "PATCH", { from: oldPath, to: newPath });
    } catch (e: any) {
      console.error(`Cloud MCP: Failed to rename ${oldPath}:`, e);
    }
  }

  // --- Helpers ---

  private async ensureFolder(folderPath: string): Promise<void> {
    const existing = this.plugin.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.plugin.app.vault.createFolder(folderPath);
    }
  }
}
