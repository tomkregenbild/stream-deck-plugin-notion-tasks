import streamDeck, {
  SingletonAction,
  action,
  type DidReceiveSettingsEvent,
  type JsonObject,
  type JsonValue,
  type KeyUpEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { KeyAction } from "@elgato/streamdeck";

import { NotionClient } from "../notion/database-helpers";

const logger = streamDeck.logger.createScope("notion-habit");

const TITLE_MAX_LINES = 3;
const TITLE_MAX_CHARS = 14;

type KeyVisualDescriptor = {
  id: string;
  start: string;
  end: string;
  label: string;
  labelColor: string;
  border: string;
  accent: string;
  badgeBg: string;
  badgeColor: string;
  titleColor: string;
};

export type HabitSettings = {
  token?: string;
  db?: string;
  columnProp?: string;
  _dbProperties?: Record<string, { 
    type: string; 
    checkbox?: {};
    rich_text?: {};
    title?: {};
    number?: {};
  }>;
  _dbPropertiesError?: string;
  _triggerPropertyFetch?: number;
};

interface NormalizedHabitSettings {
  token?: string;
  db?: string;
  columnProp?: string;
  _dbProperties?: Record<string, { 
    type: string; 
    checkbox?: {};
    rich_text?: {};
    title?: {};
    number?: {};
  }>;
}

interface HabitRecord {
  id: string;
  columnValue?: boolean | string | number;
  columnType: string;
}

interface ContextState {
  id: string;
  action: KeyAction<HabitSettings>;
  settings: HabitSettings;
  normalized: NormalizedHabitSettings;
  habitRecord?: HabitRecord;
  error?: string;
}

class HabitCoordinator {
  private contexts = new Map<string, ContextState>();
  private cache = new Map<string, { record?: HabitRecord; error?: string; timestamp: number }>();
  private inflight = new Map<string, Promise<{ record?: HabitRecord; error?: string }>>();

  async register(id: string, action: KeyAction<HabitSettings>): Promise<void> {
    logger.debug("Registering habit context", { context: id });
    const settings = await action.getSettings<HabitSettings>();
    const normalized = this.normalizeSettings(settings);
    
    this.contexts.set(id, {
      id,
      action,
      settings,
      normalized,
    });
    
    await this.fetchAndPaint(id, false);
  }

  unregister(id: string): void {
    logger.debug("Unregistering habit context", { context: id });
    this.contexts.delete(id);
    this.cache.delete(id);
    this.inflight.delete(id);
  }

  async updateSettings(id: string, settings: HabitSettings): Promise<void> {
    const state = this.contexts.get(id);
    if (!state) return;

    state.settings = settings;
    state.normalized = this.normalizeSettings(settings);
    
    // Clear cache if critical settings changed
    const cacheKey = this.getCacheKey(state.normalized);
    if (cacheKey && this.cache.has(cacheKey)) {
      this.cache.delete(cacheKey);
    }
    
    await this.fetchAndPaint(id, false);
  }

  async handleKeyPress(id: string): Promise<void> {
    const state = this.contexts.get(id);
    if (!state) return;

    if (state.error) {
      await state.action.showAlert();
      return;
    }

    if (!state.habitRecord) {
      await state.action.showAlert();
      return;
    }

    const settings = state.normalized;
    if (!settings.token || !settings.db || !settings.columnProp) {
      logger.error("Missing required settings");
      await state.action.showAlert();
      return;
    }

    // For checkbox columns, toggle the value
    if (state.habitRecord.columnType === "checkbox") {
      try {
        const currentValue = Boolean(state.habitRecord.columnValue);
        logger.debug("About to toggle habit checkbox", { 
          context: id, 
          recordId: state.habitRecord.id,
          columnProp: settings.columnProp,
          currentValue, 
          newValue: !currentValue 
        });
        await this.toggleHabitCheckbox(state.habitRecord.id, settings, currentValue);
        await this.fetchAndPaint(id, true); // Force refresh
      } catch (error) {
        logger.error("Failed to toggle habit checkbox", { error });
        await state.action.showAlert();
      }
    } else {
      // For other column types (text, number, title), just show OK (no action)
      await state.action.showOk();
    }
  }

  private async fetchAndPaint(id: string, force: boolean): Promise<void> {
    const state = this.contexts.get(id);
    if (!state) return;

    const cacheKey = this.getCacheKey(state.normalized);
    if (!cacheKey) {
      state.error = "Please configure token, database, and column settings";
      await this.paint(state);
      return;
    }

    // Prevent concurrent fetches for the same cache key
    if (this.inflight.has(cacheKey)) {
      const result = await this.inflight.get(cacheKey);
      if (result) {
        state.habitRecord = result.record;
        state.error = result.error;
      }
      await this.paint(state);
      return;
    }

    // Check cache first
    if (!force) {
      const cached = this.cache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < 30_000)) {
        state.habitRecord = cached.record;
        state.error = cached.error;
        await this.paint(state);
        return;
      }
    }

    // Fetch habit data
    const fetchPromise = this.fetchHabitData(state.normalized);
    this.inflight.set(cacheKey, fetchPromise);

    try {
      const result = await fetchPromise;
      
      // Cache the result
      this.cache.set(cacheKey, {
        record: result.record,
        error: result.error,
        timestamp: Date.now()
      });

      state.habitRecord = result.record;
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

    await this.paint(state);
  }

  private async fetchHabitData(settings: NormalizedHabitSettings): Promise<{ record?: HabitRecord; error?: string }> {
    if (!settings.token || !settings.db || !settings.columnProp) {
      return { error: "Missing required settings" };
    }

    if (!settings._dbProperties || !settings._dbProperties[settings.columnProp]) {
      return { error: `Column "${settings.columnProp}" not found in database properties` };
    }

    const columnType = settings._dbProperties[settings.columnProp].type;
    
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
        return this.fetchHabitData(settings);
      }

      if (!res.ok) {
        const message = await res.text();
        return { error: `HTTP ${res.status}: ${message}` };
      }

      const data = await res.json() as any;
      const results = data.results || [];

      if (results.length === 0) {
        return { error: "No habit record found for today" };
      }

      if (results.length > 1) {
        return { error: `Multiple habit records found for today (${results.length}). Expected exactly one.` };
      }

      const record = results[0];
      const columnData = record.properties[settings.columnProp];
      
      let columnValue: boolean | string | number | undefined;
      
      if (columnType === "checkbox") {
        columnValue = columnData?.checkbox ?? false;
      } else if (columnType === "rich_text") {
        const richText = columnData?.rich_text || [];
        columnValue = richText.map((rt: any) => rt.plain_text || "").join("");
      } else if (columnType === "title") {
        const title = columnData?.title || [];
        columnValue = title.map((t: any) => t.plain_text || "").join("");
      } else if (columnType === "number") {
        columnValue = columnData?.number ?? undefined;
      } else {
        columnValue = "Unsupported column type";
      }

      return {
        record: {
          id: record.id,
          columnValue,
          columnType
        }
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Error fetching habit data", { error: errorMessage });
      return { error: errorMessage };
    }
  }

  private async toggleHabitCheckbox(recordId: string, settings: NormalizedHabitSettings, currentValue: boolean): Promise<void> {
    if (!settings.token || !settings.columnProp) {
      throw new Error("Missing token or column property");
    }

    const newValue = !currentValue;

    logger.debug("Toggling habit checkbox", { 
      recordId, 
      columnProp: settings.columnProp, 
      currentValue, 
      newValue 
    });

    const body = {
      properties: {
        [settings.columnProp]: {
          checkbox: newValue
        }
      }
    };

    const res = await fetch(`https://api.notion.com/v1/pages/${recordId}`, {
      method: "PATCH",
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
      return this.toggleHabitCheckbox(recordId, settings, currentValue);
    }

    if (!res.ok) {
      const message = await res.text();
      throw new Error(`Failed to update habit: HTTP ${res.status}: ${message}`);
    }

    logger.debug("Successfully toggled habit checkbox", { recordId, newValue });
  }

  private async paint(state: ContextState): Promise<void> {
    let descriptor: KeyVisualDescriptor;
    let title: string;
    let habitName = state.normalized.columnProp || "Habit";

    if (!state.normalized.token || !state.normalized.db) {
      logger.debug("Showing setup state", { context: state.id });
      descriptor = BASE_VISUALS.setup;
      title = wrapText("Configure Notion");
    } else if (state.error) {
      logger.warn("Showing error state", { context: state.id, error: state.error });
      descriptor = BASE_VISUALS.error;
      title = wrapText(`Error: ${state.error}`);
    } else if (!state.habitRecord) {
      logger.debug("Showing empty state", { context: state.id });
      descriptor = BASE_VISUALS.empty;
      title = wrapText("No habit data");
    } else {
      const { columnValue, columnType } = state.habitRecord;
      
      if (columnType === "checkbox") {
        const isCompleted = Boolean(columnValue);
        descriptor = isCompleted ? BASE_VISUALS["habit-complete"] : BASE_VISUALS["habit-incomplete"];
        descriptor = { ...descriptor, label: habitName }; // Use habit name as label
        title = wrapText(isCompleted ? "✓ Done" : "Todo");
      } else if (columnType === "rich_text" || columnType === "title") {
        const text = String(columnValue || "");
        const hasValue = text.trim();
        descriptor = hasValue ? BASE_VISUALS["habit-complete"] : BASE_VISUALS["habit-incomplete"];
        descriptor = { ...descriptor, label: habitName }; // Use habit name as label
        if (hasValue) {
          title = wrapText(text);
        } else {
          title = wrapText("Todo");
        }
      } else if (columnType === "number") {
        const hasValue = columnValue !== undefined && columnValue !== null;
        descriptor = hasValue ? BASE_VISUALS["habit-complete"] : BASE_VISUALS["habit-incomplete"];
        descriptor = { ...descriptor, label: habitName }; // Use habit name as label
        if (hasValue) {
          // Format number appropriately
          const numValue = Number(columnValue);
          const formattedNumber = Number.isInteger(numValue) ? numValue.toString() : numValue.toFixed(2).replace(/\.?0+$/, '');
          title = wrapText(formattedNumber);
        } else {
          title = wrapText("Todo");
        }
      } else {
        descriptor = BASE_VISUALS.error;
        title = wrapText("Unsupported type");
      }
    }

    const lines = title.split("\n").filter(line => line.trim().length > 0);
    await state.action.setImage(buildKeyImage(descriptor, habitName, lines));
    await state.action.setTitle(undefined);
  }

  private getCacheKey(settings: NormalizedHabitSettings): string | undefined {
    if (!settings.token || !settings.db || !settings.columnProp) {
      return undefined;
    }
    return `${settings.db}-${settings.columnProp}`;
  }

  private normalizeSettings(settings: HabitSettings): NormalizedHabitSettings {
    const trim = (value?: string) => {
      if (typeof value !== "string") return undefined;
      const trimmed = value.trim();
      return trimmed.length === 0 ? undefined : trimmed;
    };

    return {
      token: trim(settings.token),
      db: trim(settings.db),
      columnProp: trim(settings.columnProp),
      _dbProperties: settings._dbProperties,
    };
  }
}

// Shared coordinator instance
let sharedCoordinator: HabitCoordinator | undefined;

function getCoordinator(): HabitCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = new HabitCoordinator();
  }
  return sharedCoordinator;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Visual styling constants
const BASE_VISUALS: Record<"habit-complete" | "habit-incomplete" | "habit-text" | "empty" | "error" | "setup", KeyVisualDescriptor> = {
  "habit-complete": {
    id: "habit-complete",
    start: "#dcfce7",
    end: "#bbf7d0",
    label: "Habit",
    labelColor: "#15803d",
    border: "#86efac",
    accent: "#bbf7d0",
    badgeBg: "#22c55e",
    badgeColor: "#14532d",
    titleColor: "#15803d",
  },
  "habit-incomplete": {
    id: "habit-incomplete",
    start: "#fef3c7",
    end: "#fde68a",
    label: "Habit",
    labelColor: "#a16207",
    border: "#fcd34d",
    accent: "#fef3c7",
    badgeBg: "#f59e0b",
    badgeColor: "#92400e",
    titleColor: "#854d0e",
  },
  "habit-text": {
    id: "habit-text",
    start: "#e0f2fe",
    end: "#bfdbfe",
    label: "Habit",
    labelColor: "#1d4ed8",
    border: "#93c5fd",
    accent: "#bfdbfe",
    badgeBg: "#3b82f6",
    badgeColor: "#1e3a8a",
    titleColor: "#1e40af",
  },
  empty: {
    id: "empty",
    start: "#f5f5f4",
    end: "#e5e7eb",
    label: "Habit",
    labelColor: "#57534e",
    border: "#d6d3d1",
    accent: "#e7e5e4",
    badgeBg: "#c8c5c0",
    badgeColor: "#3f3f46",
    titleColor: "#44403c",
  },
  error: {
    id: "error",
    start: "#fef3c7",
    end: "#fee2e2",
    label: "Check",
    labelColor: "#b91c1c",
    border: "#fed7aa",
    accent: "#fde68a",
    badgeBg: "#fca5a5",
    badgeColor: "#7f1d1d",
    titleColor: "#7c2d12",
  },
  setup: {
    id: "setup",
    start: "#ede9fe",
    end: "#cffafe",
    label: "Setup",
    labelColor: "#4338ca",
    border: "#c7d2fe",
    accent: "#e0e7ff",
    badgeBg: "#a5b4fc",
    badgeColor: "#312e81",
    titleColor: "#312e81",
  },
};

function wrapText(text: string, maxChars = TITLE_MAX_CHARS, maxLines = TITLE_MAX_LINES): string {
  const sanitized = text.replace(/\s+/g, " ").trim();
  if (!sanitized) {
    return "";
  }

  const lines: string[] = [];
  let remaining = sanitized;

  while (remaining && lines.length < maxLines) {
    if (remaining.length <= maxChars) {
      lines.push(remaining);
      remaining = "";
      break;
    }

    let sliceIndex = remaining.lastIndexOf(" ", maxChars);
    if (sliceIndex <= 0) {
      sliceIndex = maxChars;
    }

    let line = remaining.slice(0, sliceIndex).trim();
    if (line.length === 0) {
      line = remaining.slice(0, maxChars);
      remaining = remaining.slice(maxChars).trimStart();
    } else {
      remaining = remaining.slice(sliceIndex).trimStart();
    }

    lines.push(line);
  }

  if (remaining.length > 0) {
    if (lines.length === 0) {
      lines.push(truncateLine(remaining, maxChars));
    } else {
      const last = lines.pop() ?? "";
      lines.push(truncateLine(`${last} ${remaining}`.trim(), maxChars));
    }
  }

  return lines.join("\n");
}

function truncateLine(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function buildKeyImage(descriptor: KeyVisualDescriptor, habitName: string, lines: string[]): string {
  const width = 144;
  const height = 144;
  const gradientId = `grad-${descriptor.id}`;

  const {
    start,
    end,
    label,
    labelColor,
    border,
    accent,
    titleColor,
  } = descriptor;

  const sanitizedLines = lines.length > 0 ? lines : [" "];

  const labelFontSize = 12; // Reduced font size to fit more text
  const labelMaxChars = 14; // Max characters per label line (increased for better fit)
  const labelMaxLines = 2; // Max lines for label
  const labelX = 15;
  const labelStartY = 26; // Adjusted start position
  const labelLineHeight = 13; // Line height for label

  const titleFontSize = 14;
  const titleStartY = 70; // Moved down to make room for multi-line label
  const titleLineHeight = titleFontSize + 6;

  // Wrap habit name for multi-line label
  const wrappedLabelLines = wrapText(habitName, labelMaxChars, labelMaxLines).split('\n');
  
  // Calculate dynamic accent bar height based on label lines
  const accentBarY = labelStartY - 6;
  const accentBarHeight = Math.max(16, wrappedLabelLines.length * labelLineHeight + 8);
  
  // Generate label lines
  const labelLines = wrappedLabelLines.map((line, index) => {
    const y = labelStartY + index * labelLineHeight;
    return `<text x="${labelX}" y="${y}" text-anchor="start" font-family="Segoe UI, system-ui, sans-serif" font-size="${labelFontSize}" font-weight="600" fill="${labelColor}">${escapeSvgText(line)}</text>`;
  }).join("");

  // Generate title lines
  const titleLines = sanitizedLines.map((line, index) => {
    const y = titleStartY + index * titleLineHeight;
    return `<text x="${width / 2}" y="${y}" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="${titleFontSize}" font-weight="700" fill="${titleColor}">${escapeSvgText(line)}</text>`;
  }).join("");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${start}" />
          <stop offset="100%" stop-color="${end}" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" rx="24" fill="url(#${gradientId})" />
      <rect x="4" y="4" width="${width - 8}" height="${height - 8}" rx="20" stroke="${border}" stroke-width="2" fill="none" />
      <rect x="18" y="${accentBarY}" width="${width - 36}" height="${accentBarHeight}" rx="8" fill="${accent}" opacity="0.6" />
      ${labelLines}
      ${titleLines}
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

@action({ UUID: "com.tom-kregenbild.notion-tasks.habit" })
export class NotionHabitAction extends SingletonAction<HabitSettings> {
  override async onWillAppear(ev: WillAppearEvent<HabitSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<HabitSettings>;
    await getCoordinator().register(action.id, action);
  }

  override async onWillDisappear(ev: WillDisappearEvent<HabitSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<HabitSettings>;
    getCoordinator().unregister(action.id);
  }

  override async onKeyUp(ev: KeyUpEvent<HabitSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<HabitSettings>;
    await getCoordinator().handleKeyPress(action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<HabitSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<HabitSettings>;
    const settings = ev.payload.settings ?? {};
    
    logger.debug("Received settings update", { 
      context: action.id,
      hasTrigger: !!settings._triggerPropertyFetch,
      hasToken: !!settings.token,
      hasDb: !!settings.db,
      hasProperties: !!settings._dbProperties
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
    
    await getCoordinator().updateSettings(action.id, settings);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, HabitSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<HabitSettings>;
    
    if (isJsonObject(ev.payload)) {
      if (ev.payload.event === 'fetchDatabaseProperties') {
        logger.debug("Handling fetchDatabaseProperties event", { 
          context: action.id,
          payload: ev.payload
        });

        const settings = await action.getSettings<HabitSettings>();
        logger.debug("Current settings", { 
          context: action.id,
          hasToken: !!settings.token,
          hasDb: !!settings.db,
          hasProperties: !!settings._dbProperties
        });
        
        if (!settings.token || !settings.db) {
          logger.error("Missing configuration", { 
            context: action.id,
            hasToken: !!settings.token,
            hasDb: !!settings.db
          });
          throw new Error('Missing token or database ID');
        }

        try {
          logger.debug("Fetching properties", { context: action.id, db: settings.db });
          const client = new NotionClient();
          const dbProperties = await client.fetchDatabaseProperties(settings.db, settings.token);
          
          logger.debug("Received properties", { 
            context: action.id,
            propertyCount: Object.keys(dbProperties.properties).length,
            properties: Object.keys(dbProperties.properties)
          });
          
          await action.setSettings({
            ...settings,
            _dbProperties: dbProperties.properties,
            _dbPropertiesError: undefined // Clear any previous error
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
          
          throw error; // Re-throw so the UI can handle it
        }
      }
    }
  }
}