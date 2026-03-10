import { App, PluginSettingTab, Setting, requestUrl } from "obsidian";
import type CloudMCPPlugin from "./main";

export interface CloudMCPSettings {
  workerUrl: string;
  apiToken: string;
  syncFolders: string[];
  excludeFolders: string[];
  autoSync: boolean;
  lastSyncTime: number;
}

export const DEFAULT_SETTINGS: CloudMCPSettings = {
  workerUrl: "",
  apiToken: "",
  syncFolders: [],
  excludeFolders: [".obsidian", ".trash"],
  autoSync: true,
  lastSyncTime: 0,
};

export class CloudMCPSettingTab extends PluginSettingTab {
  plugin: CloudMCPPlugin;

  constructor(app: App, plugin: CloudMCPPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Cloud MCP Settings" });

    // Connection section
    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Worker URL")
      .setDesc("Your Cloudflare Worker URL (e.g. https://obsidian-cloud-mcp.yourname.workers.dev)")
      .addText((text) =>
        text
          .setPlaceholder("https://obsidian-cloud-mcp.yourname.workers.dev")
          .setValue(this.plugin.settings.workerUrl)
          .onChange(async (value) => {
            this.plugin.settings.workerUrl = value.replace(/\/+$/, ""); // trim trailing slash
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API Token")
      .setDesc("The token you set with `wrangler secret put API_TOKEN`")
      .addText((text) =>
        text
          .setPlaceholder("your-secret-token")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value;
            await this.plugin.saveSettings();
          })
      );

    // Test connection button
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the worker is reachable and token is valid")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          btn.setButtonText("Testing...");
          try {
            const response = await requestUrl({
              url: `${this.plugin.settings.workerUrl}/api/sync/status`,
              headers: {
                Authorization: `Bearer ${this.plugin.settings.apiToken}`,
              },
            });
            if (response.status === 200) {
              btn.setButtonText("Connected!");
              setTimeout(() => btn.setButtonText("Test"), 2000);
            } else {
              btn.setButtonText("Failed: " + response.status);
              setTimeout(() => btn.setButtonText("Test"), 3000);
            }
          } catch (e: any) {
            btn.setButtonText("Error: " + (e.message || "Connection failed"));
            setTimeout(() => btn.setButtonText("Test"), 3000);
          }
        })
      );

    // Sync section
    containerEl.createEl("h3", { text: "Sync" });

    new Setting(containerEl)
      .setName("Auto sync")
      .setDesc("Automatically sync file changes as you edit")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Include folders")
      .setDesc("Only sync these folders (comma-separated, empty = sync all)")
      .addText((text) =>
        text
          .setPlaceholder("Notes, Projects, Daily")
          .setValue(this.plugin.settings.syncFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.syncFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Exclude folders")
      .setDesc("Never sync these folders (comma-separated)")
      .addText((text) =>
        text
          .setPlaceholder(".obsidian, .trash")
          .setValue(this.plugin.settings.excludeFolders.join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludeFolders = value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // Status section
    containerEl.createEl("h3", { text: "Status" });

    const lastSync = this.plugin.settings.lastSyncTime
      ? new Date(this.plugin.settings.lastSyncTime).toLocaleString()
      : "Never";

    new Setting(containerEl)
      .setName("Last sync")
      .setDesc(lastSync);

    // MCP URL section
    containerEl.createEl("h3", { text: "Claude Setup" });

    const workerUrl = this.plugin.settings.workerUrl;
    const isConfigured = !!(workerUrl && this.plugin.settings.apiToken);
    const sseUrl = isConfigured ? `${workerUrl}/sse` : "";
    const mcpUrl = isConfigured ? `${workerUrl}/mcp` : "";

    new Setting(containerEl)
      .setName("SSE URL (Claude Web / Desktop / Phone)")
      .setDesc("Settings > Integrations > Custom Connectors > Add")
      .addText((text) =>
        text
          .setValue(sseUrl || "Configure worker URL and token first")
          .setDisabled(true)
      );

    new Setting(containerEl)
      .setName("Streamable HTTP URL (Claude Code)")
      .setDesc("Add to ~/.claude.json under mcpServers")
      .addText((text) =>
        text
          .setValue(mcpUrl || "Configure worker URL and token first")
          .setDisabled(true)
      );

    // Copy buttons
    if (isConfigured) {
      new Setting(containerEl)
        .setName("Copy SSE URL")
        .addButton((btn) =>
          btn.setButtonText("Copy").onClick(async () => {
            await navigator.clipboard.writeText(sseUrl);
            btn.setButtonText("Copied!");
            setTimeout(() => btn.setButtonText("Copy"), 2000);
          })
        );
      new Setting(containerEl)
        .setName("Copy Streamable HTTP URL")
        .addButton((btn) =>
          btn.setButtonText("Copy").onClick(async () => {
            await navigator.clipboard.writeText(mcpUrl);
            btn.setButtonText("Copied!");
            setTimeout(() => btn.setButtonText("Copy"), 2000);
          })
        );
    }
  }
}
