import { describe, expect, it } from "vitest";

import {
  buildTaskSummary,
  compareDateStrings,
  extractDateValue,
  extractPropertyText,
  prioritySortIndex,
  sortTasks,
} from "../src/notion/task-helpers";

describe("extractPropertyText", () => {
  it("handles status, select, multi-select, and rich text properties", () => {
    const statusValue = extractPropertyText({
      type: "status",
      status: { name: "In Progress" },
    } as any);
    expect(statusValue).toBe("In Progress");

    const selectValue = extractPropertyText({
      type: "select",
      select: { name: "Focus" },
    } as any);
    expect(selectValue).toBe("Focus");

    const multiSelectValue = extractPropertyText({
      type: "multi_select",
      multi_select: [{ name: "Alpha" }, { name: "Beta" }],
    } as any);
    expect(multiSelectValue).toBe("Alpha");

    const richTextValue = extractPropertyText({
      type: "rich_text",
      rich_text: [
        { plain_text: "  hello" },
        { plain_text: "world  " },
      ],
    } as any);
    expect(richTextValue).toBe("hello world");
  });
});

describe("extractDateValue", () => {
  it("returns ISO start date when available", () => {
    const result = extractDateValue({
      type: "date",
      date: { start: "2024-09-12", end: null },
    } as any);
    expect(result).toBe("2024-09-12");

    const missing = extractDateValue({
      type: "date",
      date: { start: undefined, end: undefined },
    } as any);
    expect(missing).toBeUndefined();
  });
});

describe("prioritySortIndex", () => {
  it("sorts known priorities consistently and handles aliases", () => {
    const remember = prioritySortIndex("Remember");
    const quick = prioritySortIndex("Quick Task");
    const first = prioritySortIndex("1st Priority");
    const firstAlias = prioritySortIndex("First Priority");
    const unknown = prioritySortIndex("Zebra");

    expect(remember).toBeLessThan(quick);
    expect(quick).toBeLessThan(first);
    expect(first).toBe(firstAlias);
    expect(unknown).toBeGreaterThan(first);
  });
});

describe("sortTasks", () => {
  it("orders by due date, then priority, then title", () => {
    const tasks = [
      { id: "1", title: "Beta", priority: "3rd Priority", due: "2024-09-03" },
      { id: "2", title: "Alpha", priority: "1st Priority", due: "2024-09-03" },
      { id: "3", title: "Gamma", priority: "Meetings", due: "2024-09-02" },
      { id: "4", title: "Delta", priority: "1st Priority", due: "2024-09-03" },
    ] as any;

    const ordered = sortTasks(tasks);
    expect(ordered.map(task => task.id)).toEqual(["3", "2", "4", "1"]);
  });
});

describe("buildTaskSummary", () => {
  it("aggregates totals, groupings, and next meeting", () => {
    const tasks = [
      {
        id: "1",
        title: "Stand-up",
        priority: "Meetings",
        status: "In Progress",
        due: "2024-09-05",
        pillar: "Operations",
        project: "Internal",
      },
      {
        id: "2",
        title: "Close Tickets",
        priority: "Remember",
        status: "Done",
        due: "2024-09-05",
        pillar: "Operations",
        project: "Internal",
      },
      {
        id: "3",
        title: "Partner Call",
        priority: "Meetings",
        status: "In Progress",
        due: "2024-09-04",
        pillar: "Operations",
        project: "External",
      },
      {
        id: "4",
        title: "Ship Feature",
        priority: "1st Priority",
        status: "In Progress",
        due: "2024-09-03",
        pillar: "Product",
        project: "App",
      },
    ] as any;

    const summary = buildTaskSummary(tasks, "Done");

    expect(summary.total).toBe(4);
    expect(summary.completed).toBe(1);
    expect(summary.active).toBe(3);
    expect(summary.byPillar).toEqual({ Operations: 2, Product: 1 });
    expect(summary.byProject).toEqual({ Internal: 1, External: 1, App: 1 });
    expect(summary.nextMeeting?.id).toBe("3");
    expect(summary.activeTasks.map(task => task.id)).toEqual(["4", "3", "1"]);
  });
});

describe("compareDateStrings", () => {
  it("handles undefined dates predictably", () => {
    expect(compareDateStrings(undefined, undefined)).toBe(0);
    expect(compareDateStrings(undefined, "2024-09-01")).toBe(1);
    expect(compareDateStrings("2024-09-01", undefined)).toBe(-1);
    expect(compareDateStrings("2024-09-01", "2024-09-02")).toBeLessThan(0);
  });
});
