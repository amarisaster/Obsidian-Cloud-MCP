import { Plugin, TFile, Notice, requestUrl, debounce } from "obsidian";
import { CloudMCPSettings, DEFAULT_SETTINGS, CloudMCPSettingTab } from "./settings";
import { VaultSync } from "./sync";

export default class CloudMCPPlugin extends Plugin {
  settings: CloudMCPSettings = DEFAULT_SETTINGS;
  sync: VaultSync | null = null;
  private statusBarEl: HTMLElement | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CloudMCPSettingTab(this.app, this));

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.updateStatusBar("idle");

    // Only start sync if configured
    if (this.settings.workerUrl && this.settings.apiToken) {
      this.sync = new VaultSync(this);
      await this.startSync();
    }

    // Commands
    this.addCommand({
      id: "sync-now",
      name: "Sync vault now",
      callback: () => this.syncNow(),
    });

    this.addCommand({
      id: "full-resync",
      name: "Full resync (re-upload everything)",
      callback: () => this.fullResync(),
    });
  }

  async startSync() {
    if (!this.sync) return;

    // File watchers for incremental sync
    const debouncedSync = debounce(
      (file: TFile) => this.sync?.syncFile(file),
      2000,
      false
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && this.shouldSync(file)) {
          debouncedSync(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        if (file instanceof TFile && this.shouldSync(file)) {
          debouncedSync(file);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile && this.shouldSync(file)) {
          this.sync?.deleteRemote(file.path);
        }
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile && this.shouldSync(file)) {
          this.sync?.renameRemote(oldPath, file.path);
        }
      })
    );

    // Initial sync on load
    if (this.settings.autoSync) {
      // Small delay to let Obsidian fully load
      setTimeout(() => this.syncNow(), 3000);
    }
  }

  shouldSync(file: TFile): boolean {
    // Check extension
    if (!file.extension.match(/^(md|txt|canvas)$/)) return false;

    // Check exclude folders
    for (const folder of this.settings.excludeFolders) {
      if (folder && file.path.startsWith(folder)) return false;
    }

    // Check include folders (empty = sync all)
    if (this.settings.syncFolders.length > 0 && this.settings.syncFolders[0] !== "") {
      const inIncluded = this.settings.syncFolders.some(
        (f) => f && file.path.startsWith(f)
      );
      if (!inIncluded) return false;
    }

    return true;
  }

  async syncNow() {
    if (!this.sync) {
      new Notice("Cloud MCP: Configure worker URL and token first");
      return;
    }

    this.updateStatusBar("syncing");
    try {
      const result = await this.sync.fullSync();
      this.updateStatusBar("idle");
      new Notice(`Cloud MCP: Synced — ${result.uploaded} uploaded, ${result.downloaded} downloaded`);
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
    } catch (e: any) {
      this.updateStatusBar("error");
      new Notice(`Cloud MCP sync failed: ${e.message}`);
      console.error("Cloud MCP sync error:", e);
    }
  }

  async fullResync() {
    if (!this.sync) {
      new Notice("Cloud MCP: Configure worker URL and token first");
      return;
    }

    this.updateStatusBar("syncing");
    try {
      const result = await this.sync.fullResync();
      this.updateStatusBar("idle");
      new Notice(`Cloud MCP: Full resync — ${result.uploaded} files uploaded`);
      this.settings.lastSyncTime = Date.now();
      await this.saveSettings();
    } catch (e: any) {
      this.updateStatusBar("error");
      new Notice(`Cloud MCP resync failed: ${e.message}`);
    }
  }

  updateStatusBar(state: "idle" | "syncing" | "error") {
    if (!this.statusBarEl) return;
    switch (state) {
      case "idle":
        this.statusBarEl.setText("Cloud MCP: OK");
        break;
      case "syncing":
        this.statusBarEl.setText("Cloud MCP: Syncing...");
        break;
      case "error":
        this.statusBarEl.setText("Cloud MCP: Error");
        break;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    // Cleanup
  }
}
