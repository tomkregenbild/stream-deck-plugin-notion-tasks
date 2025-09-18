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

const DEFAULT_STATUS_PROPERTY = "Status";
const DEFAULT_DONE_VALUE = "Done";
const DEFAULT_DATE_PROPERTY = "Due";
const TITLE_MAX_LINES = 3;
const TITLE_MAX_CHARS = 14;

export type NotionSettings = {
  token?: string;
  db?: string;
  statusProp?: string;
  doneValue?: string;
  dateProp?: string;
  position?: number | string;
};

interface NormalizedSettings {
  token?: string;
  db?: string;
  statusProp: string;
  doneValue: string;
  dateProp: string;
  position?: number;
}

interface NotionTask {
  id: string;
  title: string;
  url?: string;
}

interface ContextState {
  id: string;
  action: KeyAction<NotionSettings>;
  settings: NotionSettings;
  normalized: NormalizedSettings;
  currentTask?: NotionTask;
}

@action({ UUID: "com.tom-kregenbild.notion-tasks.today" })
export class NotionTodayAction extends SingletonAction<NotionSettings> {
  private readonly coordinator = new TaskCoordinator();

  override async onWillAppear(ev: WillAppearEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<NotionSettings>;
    await this.coordinator.attach(action, ev.payload.settings ?? {});
  }

  override onWillDisappear(ev: WillDisappearEvent<NotionSettings>): void {
    const action = ev.action as unknown as KeyAction<NotionSettings>;
    this.coordinator.detach(action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<NotionSettings>;
    await this.coordinator.updateSettings(action.id, ev.payload.settings ?? {});
  }

  override async onKeyUp(ev: KeyUpEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<NotionSettings>;
    await this.coordinator.handleKeyPress(action.id);
  }

  override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, NotionSettings>): Promise<void> {
    const action = ev.action as unknown as KeyAction<NotionSettings>;
    const update = isJsonObject(ev.payload) ? (ev.payload as Partial<NotionSettings>) : undefined;
    if (!update || Object.keys(update).length === 0) {
      return;
    }
    const current = await action.getSettings<NotionSettings>();
    const merged: NotionSettings = { ...current, ...update };
    await action.setSettings(merged);
    await this.coordinator.updateSettings(action.id, merged);
  }
}

class TaskCoordinator {
  private readonly contexts = new Map<string, ContextState>();
  private readonly notion = new NotionClient();
  private readonly pendingRefreshes = new Map<string, Promise<void>>();
  private tasks: NotionTask[] = [];
  private lastError?: string;

  async attach(action: KeyAction<NotionSettings>, settings: NotionSettings): Promise<void> {
    const { normalized, persistedSettings, needsPersist } = this.normalizeAndAssign(action.id, settings);
    const state: ContextState = {
      id: action.id,
      action,
      settings: persistedSettings,
      normalized,
    };
    this.contexts.set(action.id, state);
    if (needsPersist) {
      logIfRejected(action.setSettings(persistedSettings));
    }
    await this.paint(state);
    await this.refresh();
  }

  detach(id: string): void {
    this.contexts.delete(id);
    this.refresh().catch(error => {
      streamDeck.logger.error("Failed to refresh after detach", error);
    });
  }

  async updateSettings(id: string, settings: NotionSettings): Promise<void> {
    const state = this.contexts.get(id);
    if (!state) return;
    const { normalized, persistedSettings, needsPersist } = this.normalizeAndAssign(id, settings);
    state.settings = persistedSettings;
    state.normalized = normalized;
    if (needsPersist) {
      logIfRejected(state.action.setSettings(persistedSettings));
    }
    await this.refresh(true);
  }

  async handleKeyPress(id: string): Promise<void> {
    const state = this.contexts.get(id);
    if (!state) return;
    if (!state.currentTask) {
      await state.action.showAlert();
      return;
    }
    const settings = this.primarySettings();
    if (!settings?.token || !settings?.db) {
      await state.action.showAlert();
      return;
    }

    try {
      await this.notion.markTaskDone(state.currentTask.id, settings);
      await state.action.showOk();
      await this.refresh(true);
    } catch (error) {
      streamDeck.logger.error("Failed to mark Notion task as complete", error);
      await state.action.showAlert();
    }
  }

  private async refresh(force = false): Promise<void> {
    if (this.contexts.size === 0) {
      this.tasks = [];
      this.lastError = undefined;
      return;
    }
    const settings = this.primarySettings();
    if (!settings) {
      this.tasks = [];
      this.lastError = undefined;
      await this.paintAll();
      return;
    }

    const cacheKey = settings.cacheKey;
    const existing = this.pendingRefreshes.get(cacheKey);
    if (existing && !force) {
      await existing;
      return;
    }

    const refreshPromise = (async () => {
      try {
        const { tasks, error } = await this.notion.fetchTodayTasks(settings, force);
        this.tasks = tasks;
        this.lastError = error;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.tasks = [];
        streamDeck.logger.error("Notion fetch failed", error);
      }
      await this.paintAll();
    })();

    this.pendingRefreshes.set(cacheKey, refreshPromise);
    try {
      await refreshPromise;
    } finally {
      this.pendingRefreshes.delete(cacheKey);
    }
  }

  private async paintAll(): Promise<void> {
    const tasksByPosition = new Map<number, NotionTask | undefined>();
    for (let idx = 0; idx < this.tasks.length; idx += 1) {
      tasksByPosition.set(idx + 1, this.tasks[idx]);
    }
    const contexts = Array.from(this.contexts.values()).sort((a, b) => (a.normalized.position ?? 0) - (b.normalized.position ?? 0));
    for (const context of contexts) {
      await this.paint(context, tasksByPosition.get(context.normalized.position ?? 0));
    }
  }

  private async paint(state: ContextState, task?: NotionTask): Promise<void> {

    state.currentTask = task;

    let visual: KeyVisualState = "task";

    let title: string;



    if (!state.normalized.token || !state.normalized.db) {

      visual = "setup";

      title = wrapText("Configure Notion");

    } else if (this.lastError) {

      visual = "error";

      title = wrapText(`Error ${this.lastError}`);

    } else if (!task) {

      visual = "empty";

      title = wrapText("No tasks for today");

    } else {

      visual = "task";

      title = formatTaskTitle(task.title, state.normalized.position);

    }



    await state.action.setImage(buildKeyImage(visual, state.normalized.position));

    await state.action.setTitle(title);

  }



  private primarySettings(): (NormalizedSettings & { cacheKey: string }) | undefined {
    const configured = Array.from(this.contexts.values()).find(ctx => ctx.normalized.token && ctx.normalized.db);
    if (!configured) return undefined;
    const { normalized } = configured;
    return {
      ...normalized,
      cacheKey: `${normalized.token}|${normalized.db}|${normalized.statusProp}|${normalized.doneValue}|${normalized.dateProp}`,
    };
  }

  private normalizeAndAssign(id: string, settings: NotionSettings) {
    const normalized = normalizeSettings(settings);
    const assignedPosition = this.assignPosition(id, normalized.position);
    const needsPersist = normalized.position !== assignedPosition || typeof settings.position === "string";
    const persistedSettings: NotionSettings = {
      ...settings,
      position: assignedPosition,
    };
    return {
      normalized: { ...normalized, position: assignedPosition },
      persistedSettings,
      needsPersist,
    };
  }


  private assignPosition(id: string, desired?: number): number {
    const used = new Set<number>();
    for (const [contextId, context] of this.contexts) {
      if (contextId === id) continue;
      const pos = context.normalized.position;
      if (pos && pos > 0) used.add(pos);
    }
    if (desired && desired > 0 && !used.has(desired)) {
      return desired;
    }
    let candidate = 1;
    while (used.has(candidate)) {
      candidate += 1;
    }
    return candidate;
  }
}

class NotionClient {
  private cacheKey?: string;
  private cachedTasks: NotionTask[] = [];
  private lastFetch?: number;
  private inflight?: Promise<{ tasks: NotionTask[]; error?: string }>;

  async fetchTodayTasks(settings: NormalizedSettings & { cacheKey: string }, force = false): Promise<{ tasks: NotionTask[]; error?: string }> {
    const inCacheWindow = this.cacheKey === settings.cacheKey && this.cachedTasks.length > 0 && this.lastFetch && Date.now() - this.lastFetch < 60_000;
    if (!force && inCacheWindow) {
      return { tasks: this.cachedTasks };
    }
    if (!force && this.inflight && this.cacheKey === settings.cacheKey) {
      return this.inflight;
    }

    this.cacheKey = settings.cacheKey;
    this.inflight = this.queryNotion(settings).finally(() => {
      this.inflight = undefined;
    });

    const result = await this.inflight;
    if (!result.error) {
      this.cachedTasks = result.tasks;
      this.lastFetch = Date.now();
    }
    return result;
  }

  async markTaskDone(taskId: string, settings: NormalizedSettings & { cacheKey: string }): Promise<void> {
    const headers = this.buildHeaders(settings.token);
    const res = await fetch(`https://api.notion.com/v1/pages/${taskId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        properties: {
          [settings.statusProp]: {
            status: { name: settings.doneValue },
          },
        },
      }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 1;
      await delay(retryAfter * 1_000);
      return this.markTaskDone(taskId, settings);
    }
    if (!res.ok) {
      throw new Error(`Notion update failed ${res.status}`);
    }

    this.cachedTasks = this.cachedTasks.filter(task => task.id !== taskId);
  }

  private async queryNotion(settings: NormalizedSettings & { cacheKey: string }): Promise<{ tasks: NotionTask[]; error?: string }> {
    try {
      const today = toIsoDate(new Date());
      const body = {
        page_size: 100,
        filter: {
          and: [
            { property: settings.dateProp, date: { equals: today } },
            { property: settings.statusProp, status: { does_not_equal: settings.doneValue } },
          ],
        },
        sorts: [{ property: settings.dateProp, direction: "ascending" }],
      } satisfies Record<string, unknown>;

      const res = await fetch(`https://api.notion.com/v1/databases/${settings.db}/query`, {
        method: "POST",
        headers: this.buildHeaders(settings.token),
        body: JSON.stringify(body),
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("Retry-After")) || 1;
        await delay(retryAfter * 1_000);
        return this.queryNotion(settings);
      }
      if (!res.ok) {
        const message = await safeReadText(res);
        return { tasks: [], error: `HTTP ${res.status}: ${message}` };
      }

      const data = (await res.json()) as NotionQueryResponse;
      const tasks = (data.results ?? []).map(extractTaskTitle).filter(Boolean) as NotionTask[];
      return { tasks };
    } catch (error) {
      return { tasks: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private buildHeaders(token?: string) {
    return {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };
  }
}

type NotionQueryResponse = {
  results: Array<{
    id: string;
    url?: string;
    properties: Record<string, { type: string; title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }>; status?: { name?: string } }>;
  }>;
};

function normalizeSettings(settings: NotionSettings): NormalizedSettings {
  const trim = (value?: string) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  };

  const parsePosition = (value?: number | string) => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number.parseInt(value, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    }
    return undefined;
  };

  return {
    token: trim(settings.token),
    db: trim(settings.db),
    statusProp: trim(settings.statusProp) ?? DEFAULT_STATUS_PROPERTY,
    doneValue: trim(settings.doneValue) ?? DEFAULT_DONE_VALUE,
    dateProp: trim(settings.dateProp) ?? DEFAULT_DATE_PROPERTY,
    position: parsePosition(settings.position),
  };
}

function extractTaskTitle(page: { id: string; url?: string; properties: NotionQueryResponse["results"][number]["properties"] }): NotionTask | undefined {
  const titleProperty = Object.values(page.properties).find(prop => prop.type === "title");
  const title = titleProperty?.title?.map(piece => piece.plain_text).join("") ?? "(untitled)";
  return {
    id: page.id,
    title,
    url: page.url,
  };
}

function formatTaskTitle(title: string, position?: number): string {
  const base = position && position > 0 ? `${position}. ${title}` : title;
  return wrapText(base);
}

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

type KeyVisualState = "task" | "empty" | "error" | "setup";

function buildKeyImage(style: KeyVisualState, position?: number): string {
  const palette: Record<KeyVisualState, {
    start: string;
    end: string;
    accent: string;
    baseGlow: string;
    label: string;
    labelColor: string;
    badgeBg: string;
    badgeColor: string;
    border: string;
  }> = {
    task: {
      start: "#0f172a",
      end: "#2563eb",
      accent: "#38bdf8",
      baseGlow: "#1d4ed8",
      label: "Today",
      labelColor: "#dbeafe",
      badgeBg: "#1e3a8a",
      badgeColor: "#f8fafc",
      border: "#0ea5e9",
    },
    empty: {
      start: "#1e293b",
      end: "#475569",
      accent: "#94a3b8",
      baseGlow: "#475569",
      label: "Today",
      labelColor: "#e2e8f0",
      badgeBg: "#334155",
      badgeColor: "#f8fafc",
      border: "#64748b",
    },
    error: {
      start: "#7f1d1d",
      end: "#dc2626",
      accent: "#f97316",
      baseGlow: "#b91c1c",
      label: "Check",
      labelColor: "#fee2e2",
      badgeBg: "#991b1b",
      badgeColor: "#fee2e2",
      border: "#fca5a5",
    },
    setup: {
      start: "#312e81",
      end: "#6366f1",
      accent: "#a855f7",
      baseGlow: "#4338ca",
      label: "Notion",
      labelColor: "#ede9fe",
      badgeBg: "#4338ca",
      badgeColor: "#ede9fe",
      border: "#818cf8",
    },
  };

  const width = 144;
  const height = 144;
  const gradientId = `grad-${style}`;
  const {
    start,
    end,
    accent,
    baseGlow,
    label,
    labelColor,
    badgeBg,
    badgeColor,
    border,
  } = palette[style];

  const badgeValue = position && position > 0 ? (position > 99 ? "99+" : String(position)) : undefined;
  const badge = badgeValue
    ? `<g transform="translate(${width - 48}, 20)">
        <circle cx="18" cy="18" r="18" fill="${badgeBg}" opacity="0.9" />
        <text x="18" y="24" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="${badgeValue.length > 2 ? 14 : 18}" font-weight="700" fill="${badgeColor}">${badgeValue}</text>
      </g>`
    : "";

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${start}" />
          <stop offset="100%" stop-color="${end}" />
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" rx="24" fill="url(#${gradientId})" />
      <rect x="2" y="2" width="${width - 4}" height="${height - 4}" rx="22" stroke="${border}" stroke-width="3" fill="none" opacity="0.55" />
      <rect x="12" y="${height - 44}" width="${width - 24}" height="32" rx="16" fill="${baseGlow}" opacity="0.22" />
      <rect x="16" y="14" width="${width - 32}" height="24" rx="12" fill="${accent}" opacity="0.28" />
      <text x="${width / 2}" y="32" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="15" font-weight="600" fill="${labelColor}">${label}</text>
      ${badge}
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function safeReadText(res: globalThis.Response): Promise<string> {
  try {
    return await res.text();
  } catch (error) {
    streamDeck.logger.error("Failed reading Notion response text", error);
    return "";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logIfRejected(promise: Promise<unknown> | void): void {
  if (!promise) return;
  promise.catch(error => {
    streamDeck.logger.warn("Failed to persist Stream Deck settings", error);
  });
}
