import {
  SingletonAction,
  action,
  type DialRotateEvent,
  type DidReceiveSettingsEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import type { DialAction } from "@elgato/streamdeck";

import { DEFAULT_METRICS_ORDER, type TaskSummary } from "../notion/task-helpers";
import { getNotionTodaySummary, subscribeToNotionSummary, type NotionSettings } from "./notion-today";

type DialMetric = (typeof DEFAULT_METRICS_ORDER)[number];

interface DialContextState {
  id: string;
  action: DialAction<NotionSettings>;
  settings: NotionSettings;
  metricIndex: number;
  unsubscribe?: () => void;
  layoutApplied?: boolean;
}

const TOUCH_LAYOUT_PATH = "layouts/notion-metrics.touch-layout.json";
const LOADING_FEEDBACK = {
  title: { value: "Loading Notion…" },
  value: { value: "" },
  hint: { value: "" },
} as const;

@action({ UUID: "com.tom-kregenbild.notion-tasks.today.dial" })
export class NotionTodayDialAction extends SingletonAction<NotionSettings> {
  private readonly contexts = new Map<string, DialContextState>();

  override async onWillAppear(ev: WillAppearEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<NotionSettings>;
    const state: DialContextState = {
      id: action.id,
      action,
      settings: ev.payload.settings ?? {},
      metricIndex: 0,
    };
    this.contexts.set(action.id, state);
    await applyLayoutIfNeeded(state);
    await state.action.setFeedback({ ...LOADING_FEEDBACK });
    await state.action.setTitle("Loading Notion…");
    state.unsubscribe = subscribeToNotionSummary(summary => {
      if (!this.contexts.has(state.id)) return;
      void this.paint(state, summary);
    });
    const initialSummary = getNotionTodaySummary();
    if (initialSummary) {
      await this.paint(state, initialSummary);
    }
  }

  override onWillDisappear(ev: WillDisappearEvent<NotionSettings>): void {
    const state = this.contexts.get(ev.action.id);
    if (state?.unsubscribe) {
      state.unsubscribe();
    }
    this.contexts.delete(ev.action.id);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<NotionSettings>;
    const state = this.contexts.get(action.id);
    if (!state) return;
    state.settings = ev.payload.settings ?? {};
    state.metricIndex = 0;
    await this.paint(state);
  }

  override async onDialRotate(ev: DialRotateEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<NotionSettings>;
    const state = this.contexts.get(action.id);
    if (!state) return;

    const summary = getNotionTodaySummary();
    if (!summary) return;
    const metrics = dedupeMetrics(summary.metricsOrder ?? DEFAULT_METRICS_ORDER);
    if (metrics.length === 0) return;
    const ticks = ev.payload.ticks ?? 0;
    if (ticks === 0) return;
    const nextIndex = state.metricIndex + ticks;
    state.metricIndex = ((nextIndex % metrics.length) + metrics.length) % metrics.length;
    await this.paint(state);
  }

  private async paint(state: DialContextState, summary?: TaskSummary): Promise<void> {
    const currentSummary = summary ?? getNotionTodaySummary();
    if (!currentSummary) {
      await applyLayoutIfNeeded(state);
      await state.action.setFeedback({ ...LOADING_FEEDBACK });
      await state.action.setTitle("Loading Notion…");
      return;
    }
    const metrics = dedupeMetrics(currentSummary.metricsOrder ?? DEFAULT_METRICS_ORDER);
    if (metrics.length === 0) {
      return;
    }
    if (state.metricIndex >= metrics.length) {
      state.metricIndex = metrics.length - 1;
    }
    if (state.metricIndex < 0) {
      state.metricIndex = 0;
    }
    const metric = metrics[state.metricIndex] ?? "total";

    const dialImage = buildDialImage(currentSummary, metric);
    await state.action.setImage(dialImage);
    await applyLayoutIfNeeded(state);
    const feedback = buildTouchFeedback(currentSummary, metric);
    await state.action.setFeedback(feedback);
    await state.action.setTitle(buildTouchContent(currentSummary, metric));
  }
}

function buildTouchContent(summary: TaskSummary, metric: DialMetric): string {
  const completion = summary.total === 0 ? 0 : Math.round((summary.completed / summary.total) * 100);
  switch (metric) {
    case "total":
      return `Total tasks\n${summary.total}`;
    case "completed":
      return `Completed\n${summary.completed}`;
    case "active":
      return `Active\n${summary.active}/${summary.total} (${completion}%)`;
    case "nextMeeting":
      if (summary.nextMeeting) {
        const title = truncate(summary.nextMeeting.title, 40);
        const due = summary.nextMeeting.due ? `Due ${summary.nextMeeting.due}` : "No due date";
        return `Next meeting\n${title}\n${due}`;
      }
      return "Next meeting\nNone";
    case "byPillar": {
      const top = topEntry(summary.byPillar);
      if (top) {
        return `Top pillar\n${truncate(top.label, 40)}\n${formatCount(top.count)}`;
      }
      return "Top pillar\nNone";
    }
    case "byProject": {
      const top = topEntry(summary.byProject);
      if (top) {
        return `Top project\n${truncate(top.label, 40)}\n${formatCount(top.count)}`;
      }
      return "Top project\nNone";
    }
    default:
      return `Active\n${summary.active}/${summary.total} (${completion}%)`;
  }
}

function buildDialImage(summary: TaskSummary | undefined, metric: DialMetric): string {
  const size = 96;
  const center = size / 2;
  const radius = center - 6;

  const background = "#111827";
  const stroke = "#6366f1";
  const title = "#f8fafc";
  const subtitle = "#cbd5f5";

  let mainLines: string[] = ["--"];
  let subLines: string[] = [metricLabel(metric)];

  if (summary) {
    switch (metric) {
      case "total":
        mainLines = [String(summary.total)];
        subLines = ["Total tasks"];
        break;
      case "completed":
        mainLines = [String(summary.completed)];
        subLines = ["Completed"];
        break;
      case "active":
        mainLines = [String(summary.active)];
        subLines = ["Active tasks"];
        break;
      case "nextMeeting":
        if (summary.nextMeeting?.title) {
          mainLines = wrapLines(summary.nextMeeting.title, 14, 2);
          const due = summary.nextMeeting.due ? `Due ${summary.nextMeeting.due}` : "No date";
          subLines = [due];
        } else {
          mainLines = ["None"];
          subLines = ["Next meeting"];
        }
        break;
      case "byPillar": {
        const top = topEntry(summary.byPillar);
        if (top) {
          mainLines = wrapLines(top.label, 14, 2);
          subLines = [formatCount(top.count)];
        } else {
          mainLines = ["None"];
          subLines = ["Top pillar"];
        }
        break;
      }
      case "byProject": {
        const topProject = topEntry(summary.byProject);
        if (topProject) {
          mainLines = wrapLines(topProject.label, 14, 2);
          subLines = [formatCount(topProject.count)];
        } else {
          mainLines = ["None"];
          subLines = ["Top project"];
        }
        break;
      }
      default:
        break;
    }
  }

  const mainText = renderLines(mainLines, center, center - 6, 18, title, 18, "700");
  const subtitleText = renderLines(subLines, center, center + 22, 14, subtitle, 12, "500");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <defs>
        <radialGradient id="dial-bg" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#1f2937" />
          <stop offset="100%" stop-color="${background}" />
        </radialGradient>
      </defs>
      <circle cx="${center}" cy="${center}" r="${radius}" fill="url(#dial-bg)" stroke="${stroke}" stroke-width="4" />
      ${mainText}
      ${subtitleText}
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function metricLabel(metric: DialMetric): string {
  switch (metric) {
    case "completed":
      return "Completed";
    case "active":
      return "Active";
    case "nextMeeting":
      return "Next";
    case "byPillar":
      return "Pillar";
    case "byProject":
      return "Project";
    case "total":
    default:
      return "Total";
  }
}

function topEntry(map: Record<string, number>): { label: string; count: number } | undefined {
  const entries = Object.entries(map);
  if (entries.length === 0) return undefined;
  const [label, count] = entries.sort((a, b) => b[1] - a[1])[0];
  return { label, count };
}

function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapLines(value: string, maxChars: number, maxLines: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [value];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      lines.push(truncate(word, maxChars));
    } else {
      lines.push(current);
    }
    current = word;
    if (lines.length >= maxLines - 1) {
      break;
    }
  }

  if (lines.length < maxLines && current.length > 0) {
    lines.push(current.length <= maxChars ? current : truncate(current, maxChars));
  }

  return lines.slice(0, maxLines);
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function renderLines(
  lines: string[],
  centerX: number,
  baselineY: number,
  lineHeight: number,
  color: string,
  fontSize: number,
  weight: "500" | "700",
): string {
  if (lines.length === 0) return "";
  const totalHeight = lineHeight * (lines.length - 1);
  const firstY = baselineY - totalHeight / 2;
  return lines
    .map((line, index) => {
      const y = firstY + index * lineHeight;
      return `<text x="${centerX}" y="${y}" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-weight="${weight}" font-size="${fontSize}" fill="${color}">${escape(line)}</text>`;
    })
    .join("");
}

function formatCount(count: number): string {
  return count === 1 ? "1 task" : `${count} tasks`;
}

function dedupeMetrics(metrics: DialMetric[]): DialMetric[] {
  const seen = new Set<DialMetric>();
  const result: DialMetric[] = [];
  for (const metric of metrics) {
    if (seen.has(metric)) continue;
    seen.add(metric);
    result.push(metric);
  }
  return result.length > 0 ? result : [...DEFAULT_METRICS_ORDER];
}

async function applyLayoutIfNeeded(state: DialContextState): Promise<void> {
  if (state.layoutApplied) return;
  await state.action.setFeedbackLayout(TOUCH_LAYOUT_PATH);
  state.layoutApplied = true;
}

function buildTouchFeedback(summary: TaskSummary, metric: DialMetric) {
  const completion = summary.total === 0 ? 0 : Math.round((summary.completed / summary.total) * 100);
  switch (metric) {
    case "total":
      return {
        title: { value: "Total tasks" },
        value: { value: String(summary.total) },
        hint: { value: "Rotate for details" },
      };
    case "completed":
      return {
        title: { value: "Completed" },
        value: { value: String(summary.completed) },
        hint: { value: `${summary.active} active` },
      };
    case "active":
      return {
        title: { value: "Active" },
        value: { value: `${summary.active}/${summary.total}` },
        hint: { value: `${completion}% done` },
      };
    case "nextMeeting": {
      if (summary.nextMeeting) {
        const title = truncate(summary.nextMeeting.title, 40);
        const due = summary.nextMeeting.due ? `Due ${summary.nextMeeting.due}` : "No due date";
        return {
          title: { value: "Next meeting" },
          value: { value: title },
          hint: { value: due },
        };
      }
      return {
        title: { value: "Next meeting" },
        value: { value: "None" },
        hint: { value: "Rotate for more" },
      };
    }
    case "byPillar": {
      const top = topEntry(summary.byPillar);
      if (top) {
        return {
          title: { value: "Top pillar" },
          value: { value: truncate(top.label, 40) },
          hint: { value: formatCount(top.count) },
        };
      }
      return {
        title: { value: "Top pillar" },
        value: { value: "None" },
        hint: { value: "Rotate for more" },
      };
    }
    case "byProject": {
      const top = topEntry(summary.byProject);
      if (top) {
        return {
          title: { value: "Top project" },
          value: { value: truncate(top.label, 40) },
          hint: { value: formatCount(top.count) },
        };
      }
      return {
        title: { value: "Top project" },
        value: { value: "None" },
        hint: { value: "Rotate for more" },
      };
    }
    default:
      return {
        title: { value: "Active" },
        value: { value: `${summary.active}/${summary.total}` },
        hint: { value: `${completion}% done` },
      };
  }
}









