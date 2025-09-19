# Notion Tasks Stream Deck Plugin Roadmap

This phased plan lays out how we can grow the plugin from the current key-only
experience into a richer package that powers both keys and dial actions while
exposing deeper task insights.

## Phase 0 – Discovery & Foundations

- Audit the existing key action flow, shared `TaskCoordinator`, and Notion API
  usage to confirm which data points are already fetched and cached.
- Capture current configuration points (status, done value, due date, priority)
  and note where additional settings will live (pillar, project, meeting
  overrides, dial presentation preferences).
- Document the canonical format for tasks (`NotionTask`) so future phases can
  work against the same schema.

## Phase 1 – Data Model & Fetch Enhancements

- Extend Notion queries to pull all required properties in one request
  (completed status, pillar, project, due date, priority, URLs).
- Normalize and store these fields on each task; add defensive parsing for
  select/multi-select/status/text variations.
- Introduce a shared aggregation structure (e.g. `TaskSummary`) that can be
  recomputed whenever the coordinator refreshes.
- Add unit-style tests around the sort order (due date → priority → title) and
  new parsers to prevent regressions.

## Phase 2 – Settings & Aggregations

- Expand plugin settings to capture pillar column name, project column name,
  meeting priority override, and metric ordering preferences.
- Build aggregation helpers that derive the headline metrics:
  - Total active tasks / completed tasks
  - Tasks grouped by pillar
  - Tasks grouped by project (with optional filtering by a chosen project)
  - Next upcoming meeting (priority-matched) with due date info
  - Overdue and today/tomorrow counts (stretch goal)
- Expose these aggregates through the coordinator so both key and dial actions
  can subscribe without refetching Notion.

## Phase 3 – Dial Action Scaffolding

- Create a new dial action class (e.g. `NotionTodayDialAction`) that registers
  rotate, push, and touch-bar events.
- Reuse the coordinator attachment lifecycle to access cached tasks and
  summaries.
- Render an initial dial face showing the total task count and completion
  percentage to validate the plumbing.
- Provide a configurable list of “cards” (metrics) that the dial can cycle
  through.

## Phase 4 – Dial UX Iteration

- Implement rotation logic to cycle through metric cards; optionally allow
  acceleration / wrap-around.
- Define push behaviour per card (e.g. open next meeting in browser, refresh
  data, toggle pillar/project views).
- Enhance the dial canvas rendering with compact typography, icons, and
  progress arcs; ensure accessibility on the 96×96 display.
- Add optional touch-strip feedback (where available) for quick status bars or
  progress indicators.

## Phase 5 – Advanced Insights & Integrations

- Introduce detailed views on the Stream Deck keys when a dial card is active
  (e.g. showing top 3 pillars or projects with counts and colors).
- Surface meeting reminders (e.g. highlight if a meeting is starting within
  30 minutes, flash badge, or auto-switch dial card).
- Add quick filters (pending, overdue, completed today) controlled from either
  the dial or dedicated keys.
- Consider optional desktop notifications or webhook triggers using the cached
  data (behind a setting flag).

## Phase 6 – Polish, Testing & Release

- Document new settings and usage patterns in the README and Stream Deck store
  description.
- Add end-to-end smoke tests (manual or scripted) covering dial rotation,
  meeting detection, pillar/project grouping, and totals.
- Profile Notion API usage to ensure rate limits stay within bounds; add
  telemetry/logging for cache hits/misses.
- Prepare a changelog, screenshots/GIFs, и coordinate the release submission.

## Future Ideas (Parking Lot)

- Calendar integration for meeting reminders beyond Notion’s data.
- “Focus mode” that lets the dial drill into a single project or pillar and
  update Stream Deck keys live.
- Shared task history tracking (charts for completed tasks over time).
- Localization support for labels/metrics.

This roadmap is a living document—update it as priorities shift or new insights
are discovered during development.
