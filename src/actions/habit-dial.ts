import {
  SingletonAction,
  action,
  type DialAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type SendToPluginEvent,
  type JsonValue,
  type JsonObject,
} from "@elgato/streamdeck";

import streamDeck from "@elgato/streamdeck";

import { NotionClient } from "../notion/database-helpers";

const LAYOUT_PATH = "layouts/habit-summary.touch-layout.json";

const logger = streamDeck.logger.createScope("HabitDialAction");

export interface HabitDialSettings {
  token?: string;
  db?: string;
  _dbProperties?: Record<string, { 
    type: string; 
    checkbox?: {};
    rich_text?: {};
    title?: {};
    number?: {};
  }>;
  _dbPropertiesError?: string;
  _triggerPropertyFetch?: number;
  [key: string]: any; // Index signature for JsonObject constraint
}

interface NormalizedHabitDialSettings {
  token?: string;
  db?: string;
  _dbProperties?: Record<string, { 
    type: string; 
    checkbox?: {};
    rich_text?: {};
    title?: {};
    number?: {};
  }>;
}

interface HabitSummary {
  completed: number;
  total: number;
}

interface HabitRecord {
  id: string;
  properties: Record<string, any>;
}

interface ContextState {
  id: string;
  action: DialAction<HabitDialSettings>;
  layoutApplied: boolean;
  settings: HabitDialSettings;
  normalized: NormalizedHabitDialSettings;
  summary?: HabitSummary;
  error?: string;
}

const INITIAL_FEEDBACK = {
  heading: { value: "Habits" },
  value: { value: "Loading..." },
  progress: 0,
} as const;

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

@action({ UUID: "com.tom-kregenbild.notion-tasks.habits.dial" })
export class HabitDialAction extends SingletonAction<HabitDialSettings> {
  private readonly contexts = new Map<string, ContextState>();
  private cache = new Map<string, { summary?: HabitSummary; error?: string; timestamp: number }>();
  private inflight = new Map<string, Promise<{ summary?: HabitSummary; error?: string }>>();

  override async onWillAppear(ev: WillAppearEvent<HabitDialSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<HabitDialSettings>;
    const settings = await action.getSettings<HabitDialSettings>();
    const normalized = this.normalizeSettings(settings);
    
    const state: ContextState = {
      id: action.id,
      action,
      layoutApplied: false,
      settings,
      normalized,
    };
    this.contexts.set(state.id, state);

    logger.debug("onWillAppear", { context: state.id });

    await this.ensureLayout(state);
    await action.setTitle("Habits");
    await action.setFeedback({ ...INITIAL_FEEDBACK });

    // Auto-fetch database properties if missing
    if (settings.token && settings.db && !settings._dbProperties) {
      logger.debug("Database properties missing, triggering fetch", { context: state.id });
      try {
        const client = new NotionClient();
        const dbProperties = await client.fetchDatabaseProperties(settings.db, settings.token);
        
        const updatedSettings = {
          ...settings,
          _dbProperties: dbProperties.properties,
          _dbPropertiesError: undefined
        };
        
        await action.setSettings(updatedSettings);
        state.settings = updatedSettings;
        state.normalized = this.normalizeSettings(updatedSettings);
        
        logger.debug("Database properties fetched successfully", { 
          context: state.id, 
          propertyCount: Object.keys(dbProperties.properties).length 
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Failed to fetch database properties on appear", { 
          context: state.id,
          error: errorMessage
        });
        
        await action.setSettings({
          ...settings,
          _dbPropertiesError: errorMessage
        });
      }
    }

    await this.fetchAndUpdate(state, false);
  }

  override onWillDisappear(ev: WillDisappearEvent<HabitDialSettings>): void {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onWillDisappear:missing", { context: ev.action.id });
      return;
    }

    logger.debug("onWillDisappear", { context: state.id });
    this.contexts.delete(state.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<HabitDialSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<HabitDialSettings>;
    const settings = ev.payload.settings ?? {};
    
    logger.debug("Received settings update", { 
      context: action.id,
      hasTrigger: !!settings._triggerPropertyFetch,
      hasToken: !!settings.token,
      hasDb: !!settings.db
    });
    
    // Check if this is a property fetch trigger
    if (settings._triggerPropertyFetch && settings.token && settings.db) {
      logger.debug("Settings-triggered property fetch detected", { 
        context: action.id,
        trigger: settings._triggerPropertyFetch
      });
      
      try {
        const client = new NotionClient();
        const dbProperties = await client.fetchDatabaseProperties(settings.db, settings.token);
        
        await action.setSettings({
          ...settings,
          _dbProperties: dbProperties.properties,
          _dbPropertiesError: undefined,
          _triggerPropertyFetch: undefined // Clear the trigger
        });
        logger.debug("Properties fetched via settings trigger", { context: action.id });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Failed to fetch properties via settings trigger", { 
          context: action.id,
          error: errorMessage
        });
        
        await action.setSettings({
          ...settings,
          _dbPropertiesError: errorMessage,
          _triggerPropertyFetch: undefined // Clear the trigger
        });
      }
    }

    const state = this.contexts.get(action.id);
    if (state) {
      state.settings = settings;
      state.normalized = this.normalizeSettings(settings);
      
      // Clear cache if critical settings changed
      const cacheKey = this.getCacheKey(state.normalized);
      if (cacheKey && this.cache.has(cacheKey)) {
        this.cache.delete(cacheKey);
      }
      
      await this.fetchAndUpdate(state, false);
    }
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, HabitDialSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<HabitDialSettings>;
    
    if (isJsonObject(ev.payload)) {
      if (ev.payload.event === 'fetchDatabaseProperties') {
        logger.debug("Handling fetchDatabaseProperties event", { 
          context: action.id,
          payload: ev.payload
        });

        const settings = await action.getSettings<HabitDialSettings>();
        
        if (!settings.token || !settings.db) {
          logger.error("Missing configuration", { 
            context: action.id,
            hasToken: !!settings.token,
            hasDb: !!settings.db
          });
          throw new Error('Missing token or database ID');
        }

        try {
          const client = new NotionClient();
          const dbProperties = await client.fetchDatabaseProperties(settings.db, settings.token);
          
          await action.setSettings({
            ...settings,
            _dbProperties: dbProperties.properties,
            _dbPropertiesError: undefined
          });
          
          logger.debug("Properties updated in settings", { context: action.id });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("Failed to fetch properties", { 
            context: action.id,
            error: errorMessage
          });
          
          await action.setSettings({
            ...settings,
            _dbPropertiesError: errorMessage
          });
          
          throw error;
        }
      }
    }
  }

  private async ensureLayout(state: ContextState): Promise<void> {
    if (state.layoutApplied) {
      return;
    }

    try {
      logger.trace("layout:apply", { context: state.id, layout: LAYOUT_PATH });
      await state.action.setFeedbackLayout(LAYOUT_PATH);
      state.layoutApplied = true;
      logger.trace("layout:applied", { context: state.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("layout:error", { context: state.id, layout: LAYOUT_PATH, message });
    }
  }

  private async fetchAndUpdate(state: ContextState, force: boolean): Promise<void> {
    const cacheKey = this.getCacheKey(state.normalized);
    if (!cacheKey) {
      state.error = "Please configure token and database settings";
      await this.updateFeedback(state);
      return;
    }

    // Check if database properties are loaded
    if (!state.normalized._dbProperties) {
      state.error = "Loading database properties...";
      await this.updateFeedback(state);
      return;
    }

    // Prevent concurrent fetches for the same cache key
    if (this.inflight.has(cacheKey)) {
      const result = await this.inflight.get(cacheKey);
      if (result) {
        state.summary = result.summary;
        state.error = result.error;
      }
      await this.updateFeedback(state);
      return;
    }

    // Check cache first
    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < 60_000)) { // 1-minute cache
        state.summary = cached.summary;
        state.error = cached.error;
        await this.updateFeedback(state);
        return;
      }
    }

    // Fetch habit data
    const fetchPromise = this.fetchHabitSummary(state.normalized);
    this.inflight.set(cacheKey, fetchPromise);

    try {
      const result = await fetchPromise;
      
      // Cache the result
      this.cache.set(cacheKey, {
        summary: result.summary,
        error: result.error,
        timestamp: Date.now()
      });

      state.summary = result.summary;
      state.error = result.error;
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to fetch habit data", { error: errorMessage });
      state.error = errorMessage;
      
      this.cache.set(cacheKey, {
        error: errorMessage,
        timestamp: Date.now()
      });
    } finally {
      this.inflight.delete(cacheKey);
    }

    await this.updateFeedback(state);
  }

  private async fetchHabitSummary(settings: NormalizedHabitDialSettings): Promise<{ summary?: HabitSummary; error?: string }> {
    logger.debug("fetchHabitSummary called", { 
      hasToken: !!settings.token,
      hasDb: !!settings.db,
      hasDbProperties: !!settings._dbProperties,
      dbPropertiesCount: settings._dbProperties ? Object.keys(settings._dbProperties).length : 0
    });
    
    if (!settings.token || !settings.db) {
      return { error: "Missing token or database ID" };
    }

    if (!settings._dbProperties) {
      return { error: "Database properties not loaded" };
    }

    try {
      // Get today's date in ISO format
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const iso = `${yyyy}-${mm}-${dd}`;

      // Query for today's records
      const body = {
        page_size: 100,
        filter: {
          property: "Date",
          date: { equals: iso }
        }
      };

      const res = await fetch(`https://api.notion.com/v1/databases/${settings.db}/query`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.token}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After")) || 1;
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        return this.fetchHabitSummary(settings);
      }

      if (!res.ok) {
        const message = await res.text();
        return { error: `HTTP ${res.status}: ${message}` };
      }

      const data = await res.json() as any;
      const results = data.results || [];

      if (results.length === 0) {
        return { summary: { completed: 0, total: 0 } };
      }

      // Get all habit columns from the database (exclude system columns and Date)
      const habitColumns = Object.entries(settings._dbProperties)
        .filter(([propertyName, propData]) => {
          // Skip system properties and the Date property used for filtering
          if (propertyName === "Date" || propertyName === "Created time" || propertyName === "Last edited time") {
            return false;
          }
          // Include checkbox, rich_text, title, and number properties
          const type = propData.type;
          return type === "checkbox" || type === "rich_text" || type === "title" || type === "number";
        })
        .map(([propertyName]) => propertyName);

      let totalHabits = 0;
      let completedHabits = 0;

      // Process each record
      for (const record of results) {
        for (const columnName of habitColumns) {
          totalHabits++;
          
          const columnData = record.properties[columnName];
          const dbProperty = settings._dbProperties[columnName];
          
          if (!dbProperty || !columnData) {
            continue; // Skip unknown properties, count as incomplete
          }

          const columnType = dbProperty.type;
          let isCompleted = false;

          if (columnType === "checkbox") {
            isCompleted = columnData?.checkbox === true;
          } else if (columnType === "rich_text") {
            const richText = columnData?.rich_text || [];
            const textValue = richText.map((rt: any) => rt.plain_text || "").join("").trim();
            isCompleted = textValue.length > 0;
          } else if (columnType === "title") {
            const title = columnData?.title || [];
            const titleValue = title.map((t: any) => t.plain_text || "").join("").trim();
            isCompleted = titleValue.length > 0;
          } else if (columnType === "number") {
            isCompleted = columnData?.number !== null && columnData?.number !== undefined;
          }

          if (isCompleted) {
            completedHabits++;
          }
        }
      }

      return { summary: { completed: completedHabits, total: totalHabits } };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Error fetching habit summary", { error: errorMessage });
      return { error: errorMessage };
    }
  }

  private async updateFeedback(state: ContextState): Promise<void> {
    if (state.error) {
      await state.action.setFeedback({
        heading: { value: "Habits" },
        value: { value: "Error" },
        progress: 0,
      });
      await state.action.setTitle(`Error: ${state.error}`);
      return;
    }

    if (!state.summary) {
      await state.action.setFeedback({
        heading: { value: "Habits" },
        value: { value: "Loading..." },
        progress: 0,
      });
      await state.action.setTitle("Loading habits...");
      return;
    }

    const { completed, total } = state.summary;
    const ratio = total > 0 ? this.clampRatio(completed / total) : 0;
    const title = total > 0 ? `${completed} of ${total} habits` : "No habits";

    logger.trace("feedback:update", {
      context: state.id,
      completed,
      total,
      ratio,
    });

    await state.action.setFeedback({
      heading: { value: "Habits" },
      value: { value: `${completed} / ${total}` },
      progress: ratio,
    });
    await state.action.setTitle(title);
  }

  private clampRatio(value: number): number {
    if (Number.isNaN(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
  }

  private getCacheKey(settings: NormalizedHabitDialSettings): string | undefined {
    if (!settings.token || !settings.db) {
      return undefined;
    }
    return `${settings.db}`;
  }

  private normalizeSettings(settings: HabitDialSettings): NormalizedHabitDialSettings {
    const trim = (value?: string) => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    };

    return {
      token: trim(settings.token),
      db: trim(settings.db),
      _dbProperties: settings._dbProperties,
    };
  }
}