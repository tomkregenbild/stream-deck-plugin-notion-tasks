# Phase 0 – Discovery Findings

This document captures the current state of the Notion Tasks Stream Deck plugin
after auditing the existing implementation. It provides the foundation for the
subsequent roadmap phases.

## Architecture Overview

- **Entry point (`src/plugin.ts`)** registers a single `NotionTodayAction` and
  connects to the Stream Deck runtime.
- **`NotionTodayAction` (`src/actions/notion-today.ts`)** is implemented as a
  `SingletonAction`. It delegates state management to a `TaskCoordinator`,
  forwarding lifecycle events (`onWillAppear`, `onDidReceiveSettings`,
  `onKeyUp`, etc.).
- **`TaskCoordinator`** maintains per-context state, normalizes incoming
  settings, assigns key positions, and orchestrates data refreshes and painting
  for all attached keys.
- **`NotionClient`** encapsulates Notion API calls, including query execution,
  rate-limit retries, caching (with a 60s freshness window), and task update
  helpers (`markTaskDone`).
- **Rendering pipeline** formats task titles, chooses a visual palette based on
  task priority (or state such as empty/error/setup), and generates an SVG that
  is set as the key image.

## Current Settings Surface

Settings are merged and normalized per context to ensure consistent behaviour.

| Setting key    | Default    | Purpose |
| -------------- | ---------- | ------- |
| `token`        | —          | Notion integration token used for all API calls. |
| `db`           | —          | Notion database ID queried for tasks. |
| `statusProp`   | `Status`   | Column containing task status values. |
| `doneValue`    | `Done`     | Status value treated as “completed” when filtering tasks. |
| `dateProp`     | `Due`      | Date column used to identify tasks scheduled for “today”. |
| `priorityProp` | `Priority` | Column providing priority labels that drive key styling. |
| `position`     | auto       | Optional key index; reassigned automatically to avoid clashes. |

Normalization trims whitespace, converts numeric strings to numbers for
`position`, and persists sanitized values back to Stream Deck when needed.

## Notion Data Flow

1. On attach/refresh, the coordinator asks the `NotionClient` for tasks using
   the normalized settings.
2. The client issues a `databases/<db>/query` POST that filters by:
   - Date column equals today’s date.
   - Status column does not equal the configured done value.
3. Responses are cached per `(token, db, statusProp, doneValue, dateProp,
   priorityProp)` tuple to minimize repeated API calls.
4. Each page result is parsed into a `NotionTask` object via helper functions:
   - Title text extracted from the Notion title property.
   - Priority extracted from status/select/multi-select/rich-text columns.
   - Due date captured from the configured date property.
5. Tasks are sorted by due date, then priority (according to predefined
   priority order), then title.

When a user marks a task complete via key press, `markTaskDone` updates the
status property to the done value and evicts the task from the cache.

## Canonical `NotionTask` Shape

```ts
type NotionTask = {
  id: string;
  title: string;
  priority?: string;
  due?: string; // ISO start date from the configured date property
  url?: string; // Direct link back to the Notion page
};
```

This shape is the single source of truth for subsequent transformations and
rendering routines.

## Rendering States & Priority Palettes

- Base states: `task`, `empty`, `error`, `setup`.
- Priority-specific palettes cover the following normalized values: remember,
  quick task, 1st–5th priority, errand, meetings (with aliases for ordinal
  words).
- Unknown priorities fall back to the default task palette but display the raw
  priority text as the header label.

## Observations & Opportunities

- All key images derive from a single `buildKeyImage` helper; the dial action
  planned for later phases can reuse or adapt this SVG pipeline.
- The coordinator already centralizes caching and painting, making it a natural
  place to expose aggregated metrics for future dial/summary features.
- Settings currently lack pillar/project definitions; introducing those in the
  next phase will require extending normalization and cache keys.
- There is no unit test coverage yet; adding lightweight tests around parsing
  and sorting will improve confidence as features expand.

These notes conclude Phase 0. With this shared understanding, we can proceed to
Phase 1 to enrich the data model and aggregation capabilities.
