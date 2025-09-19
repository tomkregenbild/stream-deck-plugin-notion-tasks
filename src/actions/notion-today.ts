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

import {
  PRIORITY_ALIASES,
  DEFAULT_MEETING_PRIORITY,
  DEFAULT_METRICS_ORDER,
  buildTaskSummary,
  extractDateValue,
  extractPropertyText,
  normalizePriorityKey,
  sanitizeMetricsOrder,
  sortTasks,
  type NotionTask,
  type TaskSummary,
  type MetricKey,
} from "../notion/task-helpers";

const DEFAULT_STATUS_PROPERTY = "Status";
const DEFAULT_DONE_VALUE = "Done";
const DEFAULT_DATE_PROPERTY = "Due";
const DEFAULT_PRIORITY_PROPERTY = "Priority";
const DEFAULT_PILLAR_PROPERTY = "Pillar";
const DEFAULT_PROJECT_PROPERTY = "Project";
const DEFAULT_MEETING_PRIORITY_OVERRIDE = DEFAULT_MEETING_PRIORITY;
const TITLE_MAX_LINES = 3;
const TITLE_MAX_CHARS = 14;

export type NotionSettings = {
  token?: string;
  db?: string;
  statusProp?: string;
  doneValue?: string;
  dateProp?: string;
  priorityProp?: string;
  pillarProp?: string;
  projectProp?: string;
  meetingPriority?: string;
  metricsOrder?: string | string[];
  position?: number | string;
};

interface NormalizedSettings {
  token?: string;
  db?: string;
  statusProp: string;
  doneValue: string;
  dateProp: string;
  priorityProp: string;
  pillarProp: string;
  projectProp: string;
  meetingPriority: string;
  metricsOrder: MetricKey[];
  position?: number;
}

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

interface ContextState {
  id: string;
  action: KeyAction<NotionSettings>;
  settings: NotionSettings;
  normalized: NormalizedSettings;
  currentTask?: NotionTask;
}

type SummaryListener = (summary: TaskSummary | undefined) => void;

let sharedCoordinator: TaskCoordinator | undefined;
const summaryListeners = new Set<SummaryListener>();

function getCoordinator(): TaskCoordinator {
  if (!sharedCoordinator) {
    sharedCoordinator = new TaskCoordinator();
  }
  return sharedCoordinator;
}

@action({ UUID: "com.tom-kregenbild.notion-tasks.today" })
export class NotionTodayAction extends SingletonAction<NotionSettings> {
  private readonly coordinator = getCoordinator();

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
  private summary?: TaskSummary;
  private lastError?: string;

  getSummary(): TaskSummary | undefined {
    return this.summary;
  }

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
      this.summary = undefined;
      this.lastError = undefined;
      notifySummaryListeners(this.summary);
      return;
    }
    const settings = this.primarySettings();
    if (!settings) {
      this.tasks = [];
      this.summary = undefined;
      this.lastError = undefined;
      await this.paintAll();
      notifySummaryListeners(this.summary);
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
        const summary = buildTaskSummary(
          tasks,
          settings.doneValue,
          settings.meetingPriority,
          settings.metricsOrder,
        );
        this.tasks = summary.activeTasks;
        this.summary = summary;
        this.lastError = error;
        notifySummaryListeners(this.summary);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        this.tasks = [];
        this.summary = undefined;
        streamDeck.logger.error("Notion fetch failed", error);
        notifySummaryListeners(this.summary);
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

    let descriptor: KeyVisualDescriptor;
    let title: string;

    if (!state.normalized.token || !state.normalized.db) {
      descriptor = BASE_VISUALS.setup;
      title = wrapText("Configure Notion");
    } else if (this.lastError) {
      descriptor = BASE_VISUALS.error;
      title = wrapText(`Error ${this.lastError}`);
    } else if (!task) {
      descriptor = BASE_VISUALS.empty;
      title = wrapText("No tasks for today");
    } else {
      descriptor = getTaskVisual(task.priority);
      title = formatTaskTitle(task.title);
    }

    const lines = title.split("\n").filter(line => line.trim().length > 0);
    await state.action.setImage(buildKeyImage(descriptor, state.normalized.position, lines));
    await state.action.setTitle(undefined);
  }

  private primarySettings(): (NormalizedSettings & { cacheKey: string }) | undefined {
    const configured = Array.from(this.contexts.values()).find(ctx => ctx.normalized.token && ctx.normalized.db);
    if (!configured) return undefined;
    const { normalized } = configured;
    return {
      ...normalized,
      cacheKey: `${normalized.token}|${normalized.db}|${normalized.statusProp}|${normalized.doneValue}|${normalized.dateProp}|${normalized.priorityProp}|${normalized.pillarProp}|${normalized.projectProp}|${normalized.meetingPriority}|${normalized.metricsOrder.join(";")}`,
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
          property: settings.dateProp,
          date: { equals: today },
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
      const tasks = (data.results ?? [])
        .map(page => extractTask(page, settings))
        .filter((task): task is NotionTask => Boolean(task));
      return { tasks: sortTasks(tasks) };
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
    properties: Record<
      string,
      {
        type: string;
        title?: Array<{ plain_text: string }>;
        rich_text?: Array<{ plain_text: string }>;
        status?: { name?: string } | null;
        select?: { name?: string } | null;
        multi_select?: Array<{ name?: string }>;
        date?: { start?: string | null; end?: string | null } | null;
      }
    >;
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
    priorityProp: trim(settings.priorityProp) ?? DEFAULT_PRIORITY_PROPERTY,
    pillarProp: trim(settings.pillarProp) ?? DEFAULT_PILLAR_PROPERTY,
    projectProp: trim(settings.projectProp) ?? DEFAULT_PROJECT_PROPERTY,
    meetingPriority: trim(settings.meetingPriority) ?? DEFAULT_MEETING_PRIORITY_OVERRIDE,
    metricsOrder: sanitizeMetricsOrder(settings.metricsOrder ?? DEFAULT_METRICS_ORDER),
    position: parsePosition(settings.position),
  };
}

export function getNotionTodaySummary(): TaskSummary | undefined {
  return getCoordinator().getSummary();
}

export function subscribeToNotionSummary(listener: SummaryListener): () => void {
  summaryListeners.add(listener);
  try {
    listener(getCoordinator().getSummary());
  } catch (error) {
    streamDeck.logger.warn("Summary listener threw during subscribe", error);
  }
  return () => {
    summaryListeners.delete(listener);
  };
}

function notifySummaryListeners(summary: TaskSummary | undefined): void {
  for (const listener of summaryListeners) {
    try {
      listener(summary);
    } catch (error) {
      streamDeck.logger.warn("Summary listener threw", error);
    }
  }
}

function extractTask(
  page: { id: string; url?: string; properties: NotionQueryResponse["results"][number]["properties"] },
  settings: Pick<NormalizedSettings, "statusProp" | "priorityProp" | "dateProp" | "pillarProp" | "projectProp">,
): NotionTask | undefined {
  const titleProperty = Object.values(page.properties).find(prop => prop.type === "title");
  const title = titleProperty?.title?.map(piece => piece.plain_text).join("") ?? "(untitled)";
  const priority = extractPropertyText(page.properties[settings.priorityProp]);
  const status = extractPropertyText(page.properties[settings.statusProp]);
  const due = extractDateValue(page.properties[settings.dateProp]);
  const pillar = extractPropertyText(page.properties[settings.pillarProp]);
  const project = extractPropertyText(page.properties[settings.projectProp]);
  return {
    id: page.id,
    title,
    priority,
    status,
    pillar,
    project,
    due,
    url: page.url,
  };
}

function formatTaskTitle(title: string): string {
  return wrapText(title);
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

const BASE_VISUALS: Record<"task" | "empty" | "error" | "setup", KeyVisualDescriptor> = {
  task: {
    id: "task-default",
    start: "#fdf2f8",
    end: "#e0f2fe",
    label: "Today",
    labelColor: "#334155",
    border: "#fbcfe8",
    accent: "#dbeafe",
    badgeBg: "#f472b6",
    badgeColor: "#831843",
    titleColor: "#1f2937",
  },
  empty: {
    id: "empty",
    start: "#f5f5f4",
    end: "#e5e7eb",
    label: "Today",
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
    label: "Notion",
    labelColor: "#4338ca",
    border: "#c7d2fe",
    accent: "#e0e7ff",
    badgeBg: "#a5b4fc",
    badgeColor: "#312e81",
    titleColor: "#312e81",
  },
};

const PRIORITY_STYLE_MAP: Record<string, KeyVisualDescriptor> = {
  remember: {
    id: "priority-remember",
    start: "#fde2e4",
    end: "#fbcfe8",
    label: "Remember",
    labelColor: "#9d174d",
    border: "#f9a8d4",
    accent: "#fcd8e1",
    badgeBg: "#f472b6",
    badgeColor: "#831843",
    titleColor: "#9d174d",
  },
  "quick-task": {
    id: "priority-quick-task",
    start: "#ccfbf1",
    end: "#a5f3fc",
    label: "Quick Task",
    labelColor: "#0f766e",
    border: "#99f6e4",
    accent: "#99f6e4",
    badgeBg: "#2dd4bf",
    badgeColor: "#115e59",
    titleColor: "#0f172a",
  },
  "1st-priority": {
    id: "priority-1st",
    start: "#fee2e2",
    end: "#fecaca",
    label: "1st Priority",
    labelColor: "#b91c1c",
    border: "#fca5a5",
    accent: "#fecaca",
    badgeBg: "#ef4444",
    badgeColor: "#7f1d1d",
    titleColor: "#7f1d1d",
  },
  "2nd-priority": {
    id: "priority-2nd",
    start: "#ffedd5",
    end: "#fed7aa",
    label: "2nd Priority",
    labelColor: "#c2410c",
    border: "#fdba74",
    accent: "#fed7aa",
    badgeBg: "#fb923c",
    badgeColor: "#7c2d12",
    titleColor: "#9a3412",
  },
  "3rd-priority": {
    id: "priority-3rd",
    start: "#fefce8",
    end: "#fde68a",
    label: "3rd Priority",
    labelColor: "#a16207",
    border: "#fcd34d",
    accent: "#fef3c7",
    badgeBg: "#f59e0b",
    badgeColor: "#92400e",
    titleColor: "#854d0e",
  },
  "4th-priority": {
    id: "priority-4th",
    start: "#ecfccb",
    end: "#d9f99d",
    label: "4th Priority",
    labelColor: "#3f6212",
    border: "#bbf7d0",
    accent: "#dcfce7",
    badgeBg: "#84cc16",
    badgeColor: "#365314",
    titleColor: "#3f6212",
  },
  "5th-priority": {
    id: "priority-5th",
    start: "#e0f2fe",
    end: "#bfdbfe",
    label: "5th Priority",
    labelColor: "#1d4ed8",
    border: "#93c5fd",
    accent: "#bfdbfe",
    badgeBg: "#3b82f6",
    badgeColor: "#1e3a8a",
    titleColor: "#1e40af",
  },
  errand: {
    id: "priority-errand",
    start: "#fef6f0",
    end: "#fde3c8",
    label: "Errand",
    labelColor: "#9a3412",
    border: "#fbd38d",
    accent: "#fde8ce",
    badgeBg: "#f97316",
    badgeColor: "#7c2d12",
    titleColor: "#7c2d12",
  },
  meetings: {
    id: "priority-meetings",
    start: "#e0e7ff",
    end: "#c7d2fe",
    label: "Meetings",
    labelColor: "#4338ca",
    border: "#a5b4fc",
    accent: "#e0e7ff",
    badgeBg: "#6366f1",
    badgeColor: "#312e81",
    titleColor: "#312e81",
  },
};

function getTaskVisual(priority?: string): KeyVisualDescriptor {
  const trimmed = priority?.trim();
  if (!trimmed) {
    return BASE_VISUALS.task;
  }

  const normalizedKey = normalizePriorityKey(trimmed);
  const mappedKey = PRIORITY_ALIASES[normalizedKey] ?? normalizedKey;
  const style = PRIORITY_STYLE_MAP[mappedKey];
  if (style) {
    return { ...style, label: trimmed };
  }

  const fallbackId = normalizedKey ? `task-default-${normalizedKey}` : "task-default-custom";
  return { ...BASE_VISUALS.task, id: fallbackId, label: trimmed };
}

function buildKeyImage(descriptor: KeyVisualDescriptor, position: number | undefined, lines: string[]): string {
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
    badgeBg,
    badgeColor,
    titleColor,
  } = descriptor;

  const sanitizedLines = lines.length > 0 ? lines : [" "];

  const labelFontSize = 16;
  const labelY = 30;
  const labelX = 15;
  const titleFontSize = 14;
  const titleStartY = 60;
  const lineHeight = titleFontSize + 6;

  const badgeValue = position && position > 0 ? (position > 99 ? "99+" : String(position)) : undefined;
  const badgeOffsetX = width - 36;
  const badgeOffsetY = labelY - 12;
  const badge = badgeValue
    ? `<g transform="translate(${badgeOffsetX}, ${badgeOffsetY})">
        <circle cx="8" cy="8" r="12" fill="${badgeBg}" opacity="0.95" />
        <text x="8" y="12" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="12" font-weight="600" fill="${badgeColor}">${escapeSvgText(badgeValue)}</text>
      </g>`
    : "";

  const titleLines = sanitizedLines.map((line, index) => {
    const y = titleStartY + index * lineHeight;
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
      <rect x="18" y="26" width="${width - 36}" height="16" rx="8" fill="${accent}" opacity="0.6" />
      <text x="${labelX}" y="${labelY}" text-anchor="start" font-family="Segoe UI, system-ui, sans-serif" font-size="${labelFontSize}" font-weight="500" fill="${labelColor}">${escapeSvgText(label)}</text>
      ${titleLines}
      ${badge}
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
