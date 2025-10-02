import streamDeck from "@elgato/streamdeck";

const logger = streamDeck.logger.createScope("AutoRefresh");

export interface AutoRefreshSettings {
  enabled: boolean;
  intervalMinutes: number;
  detectChangesOnly: boolean;
}

export interface RefreshableDataSource {
  id: string;
  getLastModified(): Promise<number | undefined>;
  refresh(force?: boolean): Promise<void>;
}

interface DataSourceState {
  source: RefreshableDataSource;
  lastKnownModified?: number;
  lastChecked: number;
}

class AutoRefreshManager {
  private intervalId?: NodeJS.Timeout;
  private dataSources = new Map<string, DataSourceState>();
  private isRefreshing = false;
  private settings: AutoRefreshSettings = {
    enabled: true,
    intervalMinutes: 1, // Default 1 minute
    detectChangesOnly: true,
  };

  updateSettings(settings: Partial<AutoRefreshSettings>): void {
    this.settings = { ...this.settings, ...settings };
    logger.debug("Settings updated", this.settings);
    
    if (this.settings.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }

  registerDataSource(source: RefreshableDataSource): void {
    logger.debug("Registering data source", { id: source.id });
    this.dataSources.set(source.id, {
      source,
      lastChecked: 0,
    });
  }

  unregisterDataSource(id: string): void {
    logger.debug("Unregistering data source", { id });
    this.dataSources.delete(id);
    
    // Stop if no data sources remain
    if (this.dataSources.size === 0) {
      this.stop();
    }
  }

  start(): void {
    if (!this.settings.enabled || this.dataSources.size === 0) {
      return;
    }

    this.stop(); // Clear any existing interval
    
    const intervalMs = this.settings.intervalMinutes * 60 * 1000;
    logger.info("Starting auto-refresh", { 
      intervalMinutes: this.settings.intervalMinutes,
      dataSourceCount: this.dataSources.size,
      detectChangesOnly: this.settings.detectChangesOnly
    });

    this.intervalId = setInterval(() => {
      this.checkForUpdates().catch(error => {
        logger.error("Auto-refresh check failed", { 
          error: error instanceof Error ? error.message : String(error) 
        });
      });
    }, intervalMs);

    // Run initial check after a short delay
    setTimeout(() => {
      this.checkForUpdates().catch(error => {
        logger.error("Initial auto-refresh check failed", { 
          error: error instanceof Error ? error.message : String(error) 
        });
      });
    }, 10000); // 10 second delay to allow plugin to fully initialize
  }

  stop(): void {
    if (this.intervalId) {
      logger.debug("Stopping auto-refresh");
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async forceRefresh(): Promise<void> {
    logger.debug("Force refreshing all data sources");
    const refreshPromises: Promise<void>[] = [];
    
    for (const [id, state] of this.dataSources) {
      try {
        refreshPromises.push(state.source.refresh(true));
      } catch (error) {
        logger.error("Failed to force refresh data source", { 
          id, 
          error: error instanceof Error ? error.message : String(error) 
        });
      }
    }

    await Promise.allSettled(refreshPromises);
  }

  private async checkForUpdates(): Promise<void> {
    if (this.isRefreshing) {
      logger.debug("Refresh already in progress, skipping");
      return;
    }

    this.isRefreshing = true;
    const now = Date.now();

    try {
      logger.debug("Checking for updates", { 
        dataSourceCount: this.dataSources.size,
        detectChangesOnly: this.settings.detectChangesOnly
      });

      const refreshPromises: Promise<void>[] = [];
      let changesDetected = false;

      for (const [id, state] of this.dataSources) {
        try {
          if (this.settings.detectChangesOnly) {
            // Check if data has changed before refreshing
            const currentModified = await state.source.getLastModified();
            
            if (currentModified !== undefined) {
              if (state.lastKnownModified === undefined || currentModified > state.lastKnownModified) {
                logger.debug("Change detected", { 
                  id, 
                  lastKnown: state.lastKnownModified,
                  current: currentModified
                });
                state.lastKnownModified = currentModified;
                changesDetected = true;
                refreshPromises.push(state.source.refresh());
              } else {
                logger.trace("No change detected", { id });
              }
            } else {
              // Can't detect changes, refresh anyway
              logger.debug("Cannot detect changes, refreshing anyway", { id });
              refreshPromises.push(state.source.refresh());
            }
          } else {
            // Always refresh regardless of changes
            refreshPromises.push(state.source.refresh());
          }

          state.lastChecked = now;
        } catch (error) {
          logger.error("Failed to check/refresh data source", { 
            id, 
            error: error instanceof Error ? error.message : String(error) 
          });
        }
      }

      if (refreshPromises.length > 0) {
        logger.info("Auto-refresh: Refreshing data sources", { 
          count: refreshPromises.length,
          changesDetected 
        });
        await Promise.allSettled(refreshPromises);
        logger.info("Auto-refresh: Data sources refreshed successfully");
      } else if (this.settings.detectChangesOnly) {
        logger.debug("No changes detected, skipping refresh");
      }
    } finally {
      this.isRefreshing = false;
    }
  }

  getStatus(): {
    enabled: boolean;
    intervalMinutes: number;
    dataSourceCount: number;
    isRefreshing: boolean;
    lastChecked?: number;
  } {
    const lastChecked = Math.min(...Array.from(this.dataSources.values()).map(s => s.lastChecked));
    
    return {
      enabled: this.settings.enabled,
      intervalMinutes: this.settings.intervalMinutes,
      dataSourceCount: this.dataSources.size,
      isRefreshing: this.isRefreshing,
      lastChecked: lastChecked === Infinity ? undefined : lastChecked,
    };
  }
}

// Global instance
const autoRefreshManager = new AutoRefreshManager();

export { autoRefreshManager };

// Helper to create a data source for the task system
export function createTaskDataSource(
  refreshCallback: (force?: boolean) => Promise<void>,
): RefreshableDataSource {
  return {
    id: "notion-tasks",
    async getLastModified(): Promise<number | undefined> {
      // For now, we can't easily detect when Notion data changed without making API calls
      // This could be enhanced by storing the last_modified timestamp from Notion API responses
      // For simplicity, we'll return undefined to always trigger refresh
      return undefined;
    },
    async refresh(force?: boolean): Promise<void> {
      await refreshCallback(force);
    },
  };
}

// Enhanced data source that can detect changes using Notion's last_edited_time
export function createEnhancedTaskDataSource(
  getSettings: () => Promise<{ token?: string; db?: string }>,
  refreshCallback: (force?: boolean) => Promise<void>,
): RefreshableDataSource {
  return {
    id: "notion-tasks-enhanced",
    async getLastModified(): Promise<number | undefined> {
      try {
        const settings = await getSettings();
        if (!settings.token || !settings.db) {
          return undefined;
        }

        // Query Notion for the most recently modified page
        const response = await fetch(`https://api.notion.com/v1/databases/${settings.db}/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.token}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sorts: [{
              property: "last_edited_time",
              direction: "descending",
            }],
            page_size: 1,
          }),
        });

        if (!response.ok) {
          logger.warn("Failed to check last modified time", { status: response.status });
          return undefined;
        }

        const data = await response.json() as { 
          results?: Array<{ last_edited_time: string }> 
        };
        if (data.results && data.results.length > 0) {
          const lastEditedTime = data.results[0].last_edited_time;
          return new Date(lastEditedTime).getTime();
        }
        
        return undefined;
      } catch (error) {
        logger.warn("Error checking last modified time", { 
          error: error instanceof Error ? error.message : String(error) 
        });
        return undefined;
      }
    },
    async refresh(force?: boolean): Promise<void> {
      await refreshCallback(force);
    },
  };
}

// Simple habit data source that triggers habit coordinator refresh
export function createHabitDataSource(
  refreshCallback: () => Promise<void>,
): RefreshableDataSource {
  return {
    id: "notion-habits",
    async getLastModified(): Promise<number | undefined> {
      // For now, we don't have a global habit refresh system like tasks
      // Return undefined to always trigger refresh
      return undefined;
    },
    async refresh(force?: boolean): Promise<void> {
      await refreshCallback();
    },
  };
}

// Enhanced habit data source that can detect changes
export function createEnhancedHabitDataSource(
  getSettings: () => Promise<{ token?: string; db?: string }>,
  refreshCallback: () => Promise<void>,
): RefreshableDataSource {
  return {
    id: "notion-habits-enhanced",
    async getLastModified(): Promise<number | undefined> {
      try {
        const settings = await getSettings();
        if (!settings.token || !settings.db) {
          return undefined;
        }

        // Query Notion for the most recently modified page in habits database
        const response = await fetch(`https://api.notion.com/v1/databases/${settings.db}/query`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.token}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sorts: [{
              property: "last_edited_time",
              direction: "descending",
            }],
            page_size: 1,
          }),
        });

        if (!response.ok) {
          logger.warn("Failed to check habit last modified time", { status: response.status });
          return undefined;
        }

        const data = await response.json() as { 
          results?: Array<{ last_edited_time: string }> 
        };
        if (data.results && data.results.length > 0) {
          const lastEditedTime = data.results[0].last_edited_time;
          return new Date(lastEditedTime).getTime();
        }
        
        return undefined;
      } catch (error) {
        logger.warn("Error checking habit last modified time", { 
          error: error instanceof Error ? error.message : String(error) 
        });
        return undefined;
      }
    },
    async refresh(force?: boolean): Promise<void> {
      await refreshCallback();
    },
  };
}