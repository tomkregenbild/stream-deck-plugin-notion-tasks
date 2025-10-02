import streamDeck from "@elgato/streamdeck";
import { autoRefreshManager } from "./auto-refresh";
import type { NotionSettings } from "../actions/notion-today";

const logger = streamDeck.logger.createScope("GlobalSettings");

class GlobalSettingsManager {
  private settingsListeners = new Set<string>();

  // Auto-refresh settings are now fixed backend configuration, no user settings needed
  updateFromSettings(contextId: string, settings: NotionSettings): void {
    // No longer processing user auto-refresh settings - they are backend-only
    logger.debug("Context settings received (auto-refresh is backend-only)", { contextId });
  }

  registerContext(contextId: string): void {
    this.settingsListeners.add(contextId);
    logger.debug("Context registered", { contextId, totalContexts: this.settingsListeners.size });
  }

  unregisterContext(contextId: string): void {
    this.settingsListeners.delete(contextId);
    logger.debug("Context unregistered", { contextId, totalContexts: this.settingsListeners.size });
    
    // If no contexts remain, stop auto-refresh
    if (this.settingsListeners.size === 0) {
      logger.debug("No contexts remain, stopping auto-refresh");
      autoRefreshManager.updateSettings({ enabled: false });
    }
  }

  // Get status information
  getStatus(): {
    activeContexts: number;
    autoRefreshStatus: ReturnType<typeof autoRefreshManager.getStatus>;
  } {
    return {
      activeContexts: this.settingsListeners.size,
      autoRefreshStatus: autoRefreshManager.getStatus(),
    };
  }
}

// Global instance
export const globalSettingsManager = new GlobalSettingsManager();

// Helper to get current settings for logging/debugging
export function logGlobalStatus(): void {
  const status = globalSettingsManager.getStatus();
  logger.info("Global status", status);
}