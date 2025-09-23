export type NotionPropertyValue = {
  type: string;
  status?: { name?: string } | null;
  select?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
  rich_text?: Array<{ plain_text: string }>;
  date?: { start?: string | null; end?: string | null } | null;
};

export interface NotionTask {
  id: string;
  title: string;
  priority?: string;
  status?: string;
  pillar?: string;
  project?: string;
  url?: string;
  due?: string;
}

export type MetricKey = "total" | "completed" | "active" | "nextMeeting" | "byPillar" | "byProject";

export interface TaskSummary {
  total: number;
  completed: number;
  active: number;
  activeTasks: NotionTask[];
  byPillar: Record<string, number>;
  byProject: Record<string, number>;
  nextMeeting?: NotionTask;
  meetingPriority: string;
  metricsOrder: MetricKey[];
  generatedAt: number;
}

export const DEFAULT_MEETING_PRIORITY = "Meetings";

export const PRIORITY_SEQUENCE = [
  "remember",
  "quick-task",
  "1st-priority",
  "2nd-priority",
  "3rd-priority",
  "4th-priority",
  "5th-priority",
  "errand",
  "meetings",
] as const;

export const PRIORITY_ALIASES: Record<string, string> = {
  "first-priority": "1st-priority",
  "second-priority": "2nd-priority",
  "third-priority": "3rd-priority",
  "fourth-priority": "4th-priority",
  "fifth-priority": "5th-priority",
};

export const PRIORITY_ORDER = PRIORITY_SEQUENCE.reduce<Record<string, number>>((acc, key, index) => {
  acc[key] = index;
  return acc;
}, {});

const METRIC_VALUES: MetricKey[] = ["total", "completed", "active", "nextMeeting", "byPillar", "byProject"];

export const DEFAULT_METRICS_ORDER: MetricKey[] = [...METRIC_VALUES];

export function normalizePriorityKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function prioritySortIndex(priority?: string): number {
  if (!priority) {
    return PRIORITY_SEQUENCE.length + 1;
  }
  const normalizedKey = normalizePriorityKey(priority);
  if (!normalizedKey) {
    return PRIORITY_SEQUENCE.length + 1;
  }
  const mappedKey = PRIORITY_ALIASES[normalizedKey] ?? normalizedKey;
  const index = PRIORITY_ORDER[mappedKey];
  if (index !== undefined) {
    return index;
  }
  return PRIORITY_SEQUENCE.length + 1;
}

export function compareDateStrings(a?: string, b?: string): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a.localeCompare(b);
}

export function sortTasks(tasks: NotionTask[]): NotionTask[] {
  return tasks.slice().sort((a, b) => {
    const dueCompare = compareDateStrings(a.due, b.due);
    if (dueCompare !== 0) {
      return dueCompare;
    }

    const priorityCompare = prioritySortIndex(a.priority) - prioritySortIndex(b.priority);
    if (priorityCompare !== 0) {
      return priorityCompare;
    }

    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });
}

export function extractPropertyText(prop: NotionPropertyValue | undefined): string | undefined {
  if (!prop) return undefined;
  switch (prop.type) {
    case "status":
      return prop.status?.name?.trim() || undefined;
    case "select":
      return prop.select?.name?.trim() || undefined;
    case "multi_select":
      return prop.multi_select?.[0]?.name?.trim() || undefined;
    case "rich_text": {
      const raw = prop.rich_text?.map(piece => piece.plain_text).join(" ") ?? "";
      const normalized = raw.replace(/\s+/g, " ").trim();
      return normalized.length > 0 ? normalized : undefined;
    }
    default:
      return undefined;
  }
}

export function extractDateValue(prop: NotionPropertyValue | undefined): string | undefined {
  if (!prop || prop.type !== "date") return undefined;
  const value = prop.date?.start ?? undefined;
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function sanitizeMetricsOrder(input: unknown): MetricKey[] {
  const candidateArray: unknown[] = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input
          .split(',')
          .map(piece => piece.trim())
          .filter(piece => piece.length > 0)
      : [];

  const seen = new Set<MetricKey>();
  for (const candidate of candidateArray) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    const metric = METRIC_VALUES.find(value => value.toLowerCase() === normalized.toLowerCase());
    if (metric && !seen.has(metric)) {
      seen.add(metric);
    }
  }

  if (seen.size === 0) {
    return [...DEFAULT_METRICS_ORDER];
  }

  return Array.from(seen);
}

export function buildTaskSummary(
  tasks: NotionTask[],
  doneValue: string,
  meetingPriority: string,
  metricsOrder: MetricKey[],
): TaskSummary {
  const activeTasks: NotionTask[] = [];
  const byPillar: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  let completed = 0;
  let nextMeeting: NotionTask | undefined;

  const meetingKeys = new Set<string>();
  const normalizedExplicit = normalizePriorityKey(meetingPriority);
  if (normalizedExplicit) meetingKeys.add(normalizedExplicit);
  meetingKeys.add(normalizePriorityKey(DEFAULT_MEETING_PRIORITY));
  meetingKeys.add("meeting");
  meetingKeys.add("meetings");

  for (const task of tasks) {
    const completedTask = isTaskCompleted(task, doneValue);
    if (completedTask) {
      completed += 1;
      continue;
    }

    activeTasks.push(task);

    const pillarLabel = displayLabel(task.pillar, "Unspecified");
    incrementCount(byPillar, pillarLabel);

    const projectLabel = displayLabel(task.project, "Unspecified");
    incrementCount(byProject, projectLabel);

    if (!nextMeeting && meetingKeys.has(normalizePriorityKey(task.priority ?? ""))) {
      nextMeeting = task;
      continue;
    }
    if (nextMeeting && meetingKeys.has(normalizePriorityKey(task.priority ?? ""))) {
      const compare = compareDateStrings(task.due, nextMeeting.due);
      if (compare < 0) {
        nextMeeting = task;
      }
    }
  }

  if (!nextMeeting && activeTasks.length > 0) {
    const sortedActive = sortTasks(activeTasks);
    nextMeeting = sortedActive[0];
  }

  return {
    total: tasks.length,
    completed,
    active: activeTasks.length,
    activeTasks: sortTasks(activeTasks),
    byPillar,
    byProject,
    nextMeeting,
    meetingPriority,
    metricsOrder: [...metricsOrder],
    generatedAt: Date.now(),
  };
}

function isTaskCompleted(task: NotionTask, doneValue: string): boolean {
  if (!task.status) return false;
  return normalizeComparable(task.status) === normalizeComparable(doneValue);
}

function normalizeComparable(value?: string): string {
  return (value ?? "").trim().toLowerCase();
}

function displayLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function incrementCount(store: Record<string, number>, key: string): void {
  store[key] = (store[key] ?? 0) + 1;
}
