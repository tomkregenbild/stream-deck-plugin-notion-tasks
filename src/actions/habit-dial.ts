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
  type DialRotateEvent,
  type TouchTapEvent,
  type DialDownEvent,
  type DialUpEvent,
} from "@elgato/streamdeck";

import streamDeck from "@elgato/streamdeck";

import { NotionClient } from "../notion/database-helpers";

const SUMMARY_LAYOUT_PATH = "layouts/habit-summary.touch-layout.json";
const DETAIL_LAYOUT_PATH = "layouts/habit-detail.touch-layout.json";

const logger = streamDeck.logger.createScope("HabitDialAction");

export interface HabitDialSettings {
  token?: string;
  db?: string;
  includeColumns?: string;
  excludeColumns?: string;
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
  includeColumns?: string[];
  excludeColumns?: string[];
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

interface HabitItem {
  name: string;
  completed: boolean;
  type: 'checkbox' | 'rich_text' | 'title' | 'number';
  value?: any;
}

interface HabitRecord {
  id: string;
  properties: Record<string, any>;
  habits: HabitItem[];
}

interface ExtendedHabitSummary extends HabitSummary {
  records: HabitRecord[];
  allHabits: HabitItem[];
}

interface ContextState {
  id: string;
  action: DialAction<HabitDialSettings>;
  layoutApplied: boolean;
  settings: HabitDialSettings;
  normalized: NormalizedHabitDialSettings;
  summary?: ExtendedHabitSummary;
  error?: string;
  currentHabitIndex: number;
  isInDetailMode: boolean;
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
  private cache = new Map<string, { summary?: ExtendedHabitSummary; error?: string; timestamp: number }>();
  private inflight = new Map<string, Promise<{ summary?: ExtendedHabitSummary; error?: string }>>();

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
      currentHabitIndex: 0,
      isInDetailMode: false,
    };
    this.contexts.set(state.id, state);

    logger.debug("onWillAppear", { context: state.id });

    await this.ensureLayout(state);
    await action.setTitle("Habits");
    await action.setFeedback({ ...INITIAL_FEEDBACK });

    // Reset to summary mode on appear
    state.isInDetailMode = false;
    state.currentHabitIndex = 0;

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

  override async onDialRotate(ev: DialRotateEvent<HabitDialSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onDialRotate:missing", { context: ev.action.id });
      return;
    }

    if (!state.summary || !state.summary.allHabits || state.summary.allHabits.length === 0) {
      logger.debug("onDialRotate:noHabits", { context: state.id });
      return;
    }

    const direction = ev.payload.ticks > 0 ? "next" : "previous";
    const oldIndex = state.currentHabitIndex;
    const totalHabits = state.summary.allHabits.length;

    if (!state.isInDetailMode) {
      // Currently in summary mode, enter detail mode
      state.isInDetailMode = true;
      state.currentHabitIndex = direction === "next" ? 0 : totalHabits - 1;
      // Switch to detail layout
      await this.switchToLayout(state, DETAIL_LAYOUT_PATH);
    } else {
      // Currently in detail mode, navigate through habits
      if (direction === "next") {
        state.currentHabitIndex++;
        if (state.currentHabitIndex >= totalHabits) {
          // Past the last habit, return to summary mode
          state.isInDetailMode = false;
          state.currentHabitIndex = 0;
          logger.debug("onDialRotate:returnToSummary", { 
            context: state.id, 
            direction,
            totalHabits
          });
          // Switch back to summary layout
          await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
          await this.updateFeedback(state);
          return;
        }
      } else {
        state.currentHabitIndex--;
        if (state.currentHabitIndex < 0) {
          // Before the first habit, return to summary mode
          state.isInDetailMode = false;
          state.currentHabitIndex = 0;
          logger.debug("onDialRotate:returnToSummary", { 
            context: state.id, 
            direction,
            totalHabits
          });
          // Switch back to summary layout
          await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
          await this.updateFeedback(state);
          return;
        }
      }
    }

    logger.debug("onDialRotate", { 
      context: state.id, 
      direction, 
      oldIndex, 
      newIndex: state.currentHabitIndex,
      totalHabits,
      isInDetailMode: state.isInDetailMode
    });

    await this.updateFeedbackWithCurrentHabit(state);
  }

  override async onTouchTap(ev: TouchTapEvent<HabitDialSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onTouchTap:missing", { context: ev.action.id });
      return;
    }

    // Only allow toggling habits when in detail mode
    if (!state.isInDetailMode) {
      logger.debug("onTouchTap:notInDetailMode", { context: state.id });
      return;
    }

    if (!state.summary || !state.summary.allHabits || state.summary.allHabits.length === 0) {
      logger.debug("onTouchTap:noHabits", { context: state.id });
      return;
    }

    const currentHabit = state.summary.allHabits[state.currentHabitIndex];
    if (!currentHabit) {
      logger.debug("onTouchTap:noCurrentHabit", { context: state.id, index: state.currentHabitIndex });
      return;
    }

    // Only allow toggling checkbox habits
    if (currentHabit.type !== 'checkbox') {
      logger.debug("onTouchTap:notCheckboxHabit", { 
        context: state.id, 
        habitType: currentHabit.type,
        habitName: currentHabit.name
      });
      
      // Show alert for non-checkbox habits
      await ev.action.showAlert();
      return;
    }

    const settings = ev.payload.settings ?? {};
    if (!settings.token) {
      logger.debug("onTouchTap:missingToken", { context: state.id });
      return;
    }

    // Find which record contains this habit
    let recordId: string | undefined;
    let columnProp: string | undefined;

    for (const record of state.summary.records) {
      const habitInRecord = record.habits.find(h => h.name === currentHabit.name && h.type === 'checkbox');
      if (habitInRecord) {
        recordId = record.id;
        // The currentHabit.name IS the column name
        columnProp = currentHabit.name;
        break;
      }
    }

    if (!recordId || !columnProp) {
      logger.debug("onTouchTap:cannotFindHabitRecord", { 
        context: state.id,
        habitName: currentHabit.name,
        hasRecordId: !!recordId,
        hasColumnProp: !!columnProp
      });
      return;
    }

    try {
      logger.debug("onTouchTap:togglingHabit", { 
        context: state.id, 
        recordId, 
        columnProp,
        habitName: currentHabit.name,
        currentValue: currentHabit.completed
      });

      await this.toggleHabitCheckbox(recordId, columnProp, settings.token, currentHabit.completed);
      
      // Update the habit's local state immediately for responsive UI
      currentHabit.completed = !currentHabit.completed;
      
      // Stay in detail mode and refresh just the current habit display
      await this.updateFeedbackWithCurrentHabit(state);
      
      // Also update the summary data in the background
      await this.fetchAndUpdate(state, true);

      logger.debug("onTouchTap:habitToggled", { 
        context: state.id, 
        recordId,
        habitName: currentHabit.name,
        newValue: currentHabit.completed
      });
    } catch (error) {
      logger.error("onTouchTap:error", { 
        context: state.id, 
        error: error instanceof Error ? error.message : String(error) 
      });
      
      // Show error indicator
      await ev.action.showAlert();
    }
  }

  override async onDialDown(ev: DialDownEvent<HabitDialSettings>): Promise<void> {
    logger.debug("onDialDown:triggered", { context: ev.action.id });
    
    // Use the same logic as onTouchTap for dial press
    await this.onTouchTap(ev as any); // Cast since they have the same interface for our purposes
  }

  private async toggleHabitCheckbox(recordId: string, columnProp: string, token: string, currentValue: boolean): Promise<void> {
    const newValue = !currentValue;

    const headers = {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    const res = await fetch(`https://api.notion.com/v1/pages/${recordId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        properties: {
          [columnProp]: {
            checkbox: newValue
          }
        }
      }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 1;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return this.toggleHabitCheckbox(recordId, columnProp, token, currentValue);
    }

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Failed to update habit: HTTP ${res.status}: ${errorText}`);
    }
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

  private async ensureLayout(state: ContextState, layoutPath: string = SUMMARY_LAYOUT_PATH): Promise<void> {
    if (state.layoutApplied) {
      return;
    }

    try {
      logger.trace("layout:apply", { context: state.id, layout: layoutPath });
      await state.action.setFeedbackLayout(layoutPath);
      state.layoutApplied = true;
      logger.trace("layout:applied", { context: state.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("layout:error", { context: state.id, layout: layoutPath, message });
    }
  }

  private async switchToLayout(state: ContextState, layoutPath: string): Promise<void> {
    try {
      logger.trace("layout:switch", { context: state.id, layout: layoutPath });
      await state.action.setFeedbackLayout(layoutPath);
      logger.trace("layout:switched", { context: state.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("layout:switchError", { context: state.id, layout: layoutPath, message });
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

  private async fetchHabitSummary(settings: NormalizedHabitDialSettings): Promise<{ summary?: ExtendedHabitSummary; error?: string }> {
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
        return { summary: { completed: 0, total: 0, records: [], allHabits: [] } };
      }

      // Get all habit columns from the database (exclude system columns and Date)
      const allHabitColumns = Object.entries(settings._dbProperties)
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

      // Apply include/exclude filtering
      let habitColumns = allHabitColumns;
      
      // Apply include filter first (if specified)
      if (settings.includeColumns && settings.includeColumns.length > 0) {
        habitColumns = habitColumns.filter(columnName => 
          settings.includeColumns!.includes(columnName)
        );
        logger.debug("Applied include filter", { 
          includeColumns: settings.includeColumns,
          filteredColumns: habitColumns
        });
      }
      
      // Apply exclude filter (takes precedence over include)
      if (settings.excludeColumns && settings.excludeColumns.length > 0) {
        habitColumns = habitColumns.filter(columnName => 
          !settings.excludeColumns!.includes(columnName)
        );
        logger.debug("Applied exclude filter", { 
          excludeColumns: settings.excludeColumns,
          filteredColumns: habitColumns
        });
      }

      logger.debug("Final habit columns for tracking", { 
        totalAvailable: allHabitColumns.length,
        finalColumns: habitColumns,
        includeFilter: settings.includeColumns,
        excludeFilter: settings.excludeColumns
      });

      let totalHabits = 0;
      let completedHabits = 0;
      const records: HabitRecord[] = [];
      const allHabits: HabitItem[] = [];

      // Process each record
      for (const record of results) {
        const habitRecord: HabitRecord = {
          id: record.id,
          properties: record.properties,
          habits: []
        };

        for (const columnName of habitColumns) {
          totalHabits++;
          
          const columnData = record.properties[columnName];
          const dbProperty = settings._dbProperties[columnName];
          
          if (!dbProperty || !columnData) {
            const habitItem: HabitItem = {
              name: columnName,
              completed: false,
              type: dbProperty?.type as any || 'checkbox'
            };
            habitRecord.habits.push(habitItem);
            allHabits.push(habitItem);
            continue; // Skip unknown properties, count as incomplete
          }

          const columnType = dbProperty.type;
          let isCompleted = false;
          let value: any = undefined;

          if (columnType === "checkbox") {
            isCompleted = columnData?.checkbox === true;
            value = columnData?.checkbox;
          } else if (columnType === "rich_text") {
            const richText = columnData?.rich_text || [];
            const textValue = richText.map((rt: any) => rt.plain_text || "").join("").trim();
            isCompleted = textValue.length > 0;
            value = textValue;
          } else if (columnType === "title") {
            const title = columnData?.title || [];
            const titleValue = title.map((t: any) => t.plain_text || "").join("").trim();
            isCompleted = titleValue.length > 0;
            value = titleValue;
          } else if (columnType === "number") {
            isCompleted = columnData?.number !== null && columnData?.number !== undefined;
            value = columnData?.number;
          }

          const habitItem: HabitItem = {
            name: columnName,
            completed: isCompleted,
            type: columnType as any,
            value
          };

          habitRecord.habits.push(habitItem);
          allHabits.push(habitItem);

          if (isCompleted) {
            completedHabits++;
          }
        }

        records.push(habitRecord);
      }

      return { 
        summary: { 
          completed: completedHabits, 
          total: totalHabits,
          records,
          allHabits
        } 
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Error fetching habit summary", { error: errorMessage });
      return { error: errorMessage };
    }
  }

  private async updateFeedback(state: ContextState): Promise<void> {
    if (state.isInDetailMode && state.summary && state.summary.allHabits && state.summary.allHabits.length > 0) {
      // In detail mode, show current habit
      await this.updateFeedbackWithCurrentHabit(state);
      return;
    }

    // In summary mode or no habits available, show summary
    await this.updateFeedbackSummary(state);
  }

  private async updateFeedbackSummary(state: ContextState): Promise<void> {
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

  private async updateFeedbackWithCurrentHabit(state: ContextState): Promise<void> {
    if (!state.summary || !state.summary.allHabits || state.summary.allHabits.length === 0) {
      await this.updateFeedback(state);
      return;
    }

    const currentHabit = state.summary.allHabits[state.currentHabitIndex];
    if (!currentHabit) {
      await this.updateFeedback(state);
      return;
    }

    const habitPosition = `${state.currentHabitIndex + 1}/${state.summary.allHabits.length}`;
    const habitNameParts = this.formatHabitNameTwoLines(currentHabit.name);
    const statusIcon = currentHabit.completed ? "✓" : "○";
    const statusText = currentHabit.completed ? "Completed" : "Incomplete";

    logger.trace("feedback:updateWithHabit", {
      context: state.id,
      habitIndex: state.currentHabitIndex,
      habitName: currentHabit.name,
      habitCompleted: currentHabit.completed,
      habitPosition,
      habitNameParts,
    });

    await state.action.setFeedback({
      heading: { value: `Habit ${habitPosition}` },
      value: { value: `${statusIcon} ${habitNameParts.line1}` },
      value2: { value: habitNameParts.line2 },
      time: { value: statusText },
    });
    await state.action.setTitle(`Habit: ${statusIcon} ${habitNameParts.line1}`);
  }

  private formatHabitNameTwoLines(name: string): { line1: string; line2: string } {
    // Split long habit names across two lines
    const maxLineLength = 18; // Slightly shorter to account for status icon
    
    if (name.length <= maxLineLength) {
      return { line1: name, line2: "" };
    }
    
    // Try to split at a natural break point (space, dash, etc.)
    const words = name.split(/[\s\-_]/);
    let line1 = "";
    let line2 = "";
    
    for (const word of words) {
      const testLine1 = line1 ? `${line1} ${word}` : word;
      
      if (testLine1.length <= maxLineLength) {
        line1 = testLine1;
      } else {
        // Start second line
        line2 = words.slice(words.indexOf(word)).join(" ");
        break;
      }
    }
    
    // If second line is too long, truncate it
    if (line2.length > maxLineLength) {
      line2 = line2.substring(0, maxLineLength - 3) + "...";
    }
    
    // If we couldn't split naturally, force split
    if (!line2 && line1.length > maxLineLength) {
      line2 = line1.substring(maxLineLength);
      line1 = line1.substring(0, maxLineLength);
      
      if (line2.length > maxLineLength) {
        line2 = line2.substring(0, maxLineLength - 3) + "...";
      }
    }
    
    return { line1, line2 };
  }

  private truncateTitle(title: string, maxLength: number = 18): string {
    if (title.length <= maxLength) {
      return title;
    }
    return title.substring(0, maxLength - 3) + "...";
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

    const parseColumnList = (value?: string): string[] | undefined => {
      if (!value || typeof value !== "string") return undefined;
      const trimmed = value.trim();
      if (trimmed.length === 0) return undefined;
      return trimmed
        .split(',')
        .map(col => col.trim())
        .filter(col => col.length > 0);
    };

    return {
      token: trim(settings.token),
      db: trim(settings.db),
      includeColumns: parseColumnList(settings.includeColumns),
      excludeColumns: parseColumnList(settings.excludeColumns),
      _dbProperties: settings._dbProperties,
    };
  }
}