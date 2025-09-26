# Generic Plugin Adaptation Analysis

## Overview

This document analyzes the current Notion Tasks StreamDeck plugin to identify hardcoded values and configurations that prevent users with different database schemas from using the plugin effectively. The goal is to make the plugin completely generic and configurable for any Notion database structure.

## Current State Analysis

### Plugin Actions Structure

The plugin currently has 5 main actions:

1. **`notion-today.ts`** - Key button showing individual tasks (position 1-8)
2. **`complete-tasks-dial.ts`** - Dial showing task completion summary and details
3. **`notion-habit.ts`** - Key button for habit tracking
4. **`habit-dial.ts`** - Dial for habit management
5. **`next-meeting-dial.ts`** - Dial for next meeting display

### Key Configuration Issues

## 1. 🚨 **Critical: Hardcoded Priority System**

**Location**: `src/notion/task-helpers.ts`

**Problem**: The plugin has a completely hardcoded priority sequence that assumes specific priority values:

```typescript
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
```

**Impact**:

- Users with different priority values (e.g., "High/Medium/Low", "P1/P2/P3", "Urgent/Important/Normal") cannot benefit from:
  - Priority-based task sorting
  - Color-coded visual indicators
  - Intelligent task positioning

**Used in**:

- Task sorting logic (`sortTasks()`)
- Color mapping for visual indicators
- Meeting detection logic

## 2. **Missing UI Configuration Fields**

Several settings exist in the code but are not exposed in the user interface:

### Currently Missing from UI:

| Setting        | Purpose                                   | Currently Available In | Status                                                        |
| -------------- | ----------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| `pillarProp`   | Categorize tasks by "pillar" or area      | Code only, no UI       | **Active Feature** - Used for task categorization and metrics |
| `projectProp`  | Categorize tasks by project               | Code only, no UI       | **Active Feature** - Used for task categorization and metrics |
| `activeValue`  | Status value for active/in-progress tasks | Dial inspector only    | **Needed** - Should be in all inspectors                      |
| `metricsOrder` | Control order of metrics display          | Code only, no UI       | **Nice to Have** - Advanced customization                     |

### Inconsistent UI Coverage:

| Setting           | Task Key Inspector | Dial Inspector | Next Meeting Inspector |
| ----------------- | ------------------ | -------------- | ---------------------- |
| `activeValue`     | ❌ Missing         | ✅ Present     | ❌ N/A                 |
| `meetingPriority` | ❌ Missing         | ❌ Missing     | ✅ Present             |

## 3. **Hardcoded Date Filter Labels**

**Location**: `complete-tasks-dial.ts` - `updateFeedback()` method

```typescript
// Generate heading based on date filter
const dateFilter = settings?.dateFilter || "today";
let heading = "Tasks";
switch (dateFilter) {
  case "tomorrow":
    heading = "Tasks Tomorrow";
    break;
  case "weekly":
    heading = "Tasks This Week";
    break;
  default:
    heading = "Tasks Today";
    break;
}
```

**Problem**: Date filter options and labels are hardcoded, limiting customization for different workflows.

## 4. **Meeting Filter System (Not Just Priority)**

**Location**: `src/notion/task-helpers.ts` and actions

```typescript
export const DEFAULT_MEETING_PRIORITY = "Meetings";
```

**Problem**: Meeting detection currently only supports priority-based filtering (tasks with a specific priority value). Users need more flexible ways to identify meetings:

- Priority-based: `priority = "Meeting"`
- Keyword-based: title contains "meeting", "call", "standup"
- Property-based: boolean "Is Meeting" checkbox
- Tag-based: multi-select contains "meeting" tag

**Solution**: Replace single `meetingPriority` setting with a comprehensive meeting filter system that allows users to define custom criteria for meeting identification.

## 5. **Inflexible Task Position System**

**Location**: Task key inspector UI

The task position system is hardcoded to 8 slots (1-8) without considering:

- Custom sorting criteria
- Dynamic task prioritization
- User-defined task categories

## Proposed Generic Configuration Schema

### 1. **Priority System Configuration**

Replace hardcoded priority values with user-configurable settings:

```typescript
export type PrioritySystemSettings = {
  // User-defined priority values in preferred sort order (highest to lowest)
  priorityValues?: string[];

  // Optional aliases for priority values (e.g., "High" -> "1", "P1" -> "High Priority")
  priorityAliases?: Record<string, string>;

  // Priority-to-color mapping for visual indicators
  priorityColorMap?: Record<
    string,
    {
      start: string; // Gradient start color (#hex)
      end: string; // Gradient end color (#hex)
      border: string; // Border color (#hex)
      accent: string; // Accent color (#hex)
      badgeBg: string; // Badge background (#hex)
      badgeColor: string; // Badge text color (#hex)
    }
  >;
};
```

**Default Configuration Example**:

```typescript
const DEFAULT_PRIORITY_CONFIG: PrioritySystemSettings = {
  priorityValues: ["High", "Medium", "Low"],
  priorityColorMap: {
    High: {
      start: "#ff4444",
      end: "#cc0000",
      border: "#aa0000",
      accent: "#ff6666",
      badgeBg: "#ff4444",
      badgeColor: "#ffffff",
    },
    Medium: {
      start: "#ffaa00",
      end: "#cc8800",
      border: "#aa7700",
      accent: "#ffcc44",
      badgeBg: "#ffaa00",
      badgeColor: "#ffffff",
    },
    Low: {
      start: "#44aa44",
      end: "#008800",
      border: "#006600",
      accent: "#66cc66",
      badgeBg: "#44aa44",
      badgeColor: "#ffffff",
    },
  },
};
```

### 2. **Enhanced Settings Interface**

Expand `NotionSettings` to include missing configurable fields:

```typescript
export type NotionSettings = {
  // === Current Settings (keep existing) ===
  token?: string;
  db?: string;
  statusProp?: string;
  doneValue?: string;
  activeValue?: string;
  dateProp?: string;
  priorityProp?: string;
  position?: number | string;
  dateFilter?: "today" | "tomorrow" | "weekly";

  // === NEW: Missing Fields Currently in Code ===
  pillarProp?: string; // Task categorization by area/pillar
  projectProp?: string; // Task categorization by project
  metricsOrder?: string[]; // Control metrics display order

  // === NEW: Priority System Configuration ===
  priorityValues?: string[]; // User-defined priority values
  priorityAliases?: Record<string, string>;
  priorityColorMap?: Record<string, PriorityColorConfig>;

  // === NEW: Meeting Filter Configuration (replaces single meetingPriority) ===
  meetingFilter?: MeetingFilterConfig;

  // === NEW: Enhanced Date Filter Configuration ===
  dateFilterConfig?: DateFilterConfig;

  // === NEW: Task Sorting Configuration ===
  sortBy?: "priority" | "dueDate" | "custom" | "alphabetical";
  customSortProperty?: string; // Property name for custom sorting
  sortOrder?: "asc" | "desc";

  // === Internal (keep existing) ===
  _dbProperties?: Record<string, DatabaseProperty>;
  _dbPropertiesError?: string;
  _triggerPropertyFetch?: number;
};

type MeetingFilterConfig = {
  mode: "priority" | "keyword" | "property" | "tag";
  priorityValue?: string;
  keywords?: string[];
  propertyName?: string;
  tagProperty?: string;
  tagValues?: string[];
};

type DateFilterConfig = {
  useDefaults: boolean;
  customFilters?: Array<{
    id: string;
    label: string;
    startOffset: number;
    endOffset: number;
  }>;
};

type DatabaseProperty = {
  type: string;
  status?: { options: Array<{ name: string }> };
  select?: { options: Array<{ name: string }> };
  // ... other property types
};
```

### 3. **Meeting Detection Flexibility**

Replace single-mode meeting detection with multiple configurable methods:

```typescript
type MeetingFilterConfig = {
  mode: "priority" | "keyword" | "property" | "tag";

  // For priority-based detection (default)
  priorityValue?: string;

  // For keyword-based detection
  keywords?: string[];

  // For property-based detection (boolean checkbox)
  propertyName?: string;

  // For tag-based detection (multi-select property)
  tagProperty?: string;
  tagValues?: string[];
};
```

**Examples**:

- **Priority-based (default)**: `{ mode: "priority", priorityValue: "Meeting" }`
- **Keyword-based**: `{ mode: "keyword", keywords: ["meeting", "call", "standup", "1:1"] }`
- **Property-based**: `{ mode: "property", propertyName: "Is Meeting" }`
- **Tag-based**: `{ mode: "tag", tagProperty: "Tags", tagValues: ["meeting", "call"] }`

### 4. **Date Filter System Enhancement**

Keep existing hardcoded date filters as defaults while allowing custom extensions:

```typescript
type DateFilterConfig = {
  // Keep existing defaults
  useDefaults: boolean; // true = show Today, Tomorrow, This Week

  // Add custom filters
  customFilters?: Array<{
    id: string; // Unique identifier
    label: string; // Display name (e.g., "This Sprint", "Next 3 Days")
    startOffset: number; // Days from today (negative = past)
    endOffset: number; // Days from today (positive = future)
  }>;
};

// Default behavior (backwards compatible)
const DEFAULT_DATE_FILTERS: DateFilterConfig = {
  useDefaults: true,
  customFilters: [],
};

// Advanced user example
const ADVANCED_DATE_FILTERS: DateFilterConfig = {
  useDefaults: true, // Keep Today, Tomorrow, This Week
  customFilters: [
    { id: "next-sprint", label: "Next Sprint", startOffset: 0, endOffset: 13 },
    { id: "overdue", label: "Overdue", startOffset: -365, endOffset: -1 },
    { id: "this-month", label: "This Month", startOffset: 0, endOffset: 30 },
  ],
};
```

**Benefits**:

- **Backwards Compatible**: Existing users see no changes
- **Extensible**: Power users can add custom date ranges
- **Flexible**: Users can disable defaults if they want only custom filters

## Required Code Changes

### 1. **Update `task-helpers.ts`**

**Current Issues**:

- Hardcoded `PRIORITY_SEQUENCE` array
- Hardcoded `PRIORITY_ALIASES` mapping
- Hardcoded `DEFAULT_MEETING_PRIORITY`

**Required Changes**:

```typescript
// REMOVE these hardcoded constants:
// export const PRIORITY_SEQUENCE = [...]
// export const PRIORITY_ALIASES: Record<string, string> = {...}
// export const DEFAULT_MEETING_PRIORITY = "Meetings";

// ADD dynamic priority handling:
export function createPrioritySortIndex(
  priorityValues: string[],
  aliases: Record<string, string> = {}
): (priority?: string) => number {
  const priorityOrder = priorityValues.reduce<Record<string, number>>(
    (acc, value, index) => {
      acc[normalizePriorityKey(value)] = index;
      return acc;
    },
    {}
  );

  return (priority?: string): number => {
    if (!priority) return priorityValues.length + 1;

    const normalizedKey = normalizePriorityKey(priority);
    const mappedKey = aliases[normalizedKey] ?? normalizedKey;
    const index = priorityOrder[mappedKey];

    return index !== undefined ? index : priorityValues.length + 1;
  };
}

// ADD flexible meeting detection:
export function createMeetingDetector(
  config: MeetingFilterConfig
): (task: NotionTask) => boolean {
  switch (config.mode) {
    case "priority":
      return (task) => task.priority === config.priorityValue;

    case "keyword":
      const keywords = (config.keywords || []).map((k) => k.toLowerCase());
      return (task) =>
        keywords.some((keyword) => task.title.toLowerCase().includes(keyword));

    case "property":
      return (task) => Boolean(task[config.propertyName || "isMatching"]);

    case "tag":
      return (task) => {
        const tagValues = config.tagValues || [];
        const taskTags = task[config.tagProperty || "tags"];
        if (!taskTags || !Array.isArray(taskTags)) return false;
        return tagValues.some((tagValue) =>
          taskTags.some((tag) => tag.toLowerCase() === tagValue.toLowerCase())
        );
      };

    default:
      return () => false;
  }
}
```

### 2. **Update Settings Normalization**

**Location**: `notion-today.ts` - `normalizeSettings()` function

Add handling for new configuration fields:

```typescript
function normalizeSettings(settings: NotionSettings): NormalizedSettings {
  return {
    // ... existing fields ...

    // NEW: Priority system configuration
    priorityValues: settings.priorityValues || ["High", "Medium", "Low"],
    priorityAliases: settings.priorityAliases || {},
    priorityColorMap: settings.priorityColorMap || DEFAULT_PRIORITY_COLORS,

    // NEW: Meeting filter system (replaces meetingPriority)
    meetingFilter: settings.meetingFilter || {
      mode: "priority",
      priorityValue: "Meeting",
    },

    // NEW: Enhanced date filter configuration
    dateFilterConfig: settings.dateFilterConfig || {
      useDefaults: true,
      customFilters: [],
    },

    // NEW: Sorting configuration
    sortBy: settings.sortBy || "priority",
    customSortProperty: settings.customSortProperty,
    sortOrder: settings.sortOrder || "asc",

    // NEW: Missing existing fields (pillarProp and projectProp are ACTIVE features)
    pillarProp: trim(settings.pillarProp), // Used for task categorization metrics
    projectProp: trim(settings.projectProp), // Used for task categorization metrics
    metricsOrder: settings.metricsOrder || DEFAULT_METRICS_ORDER,
  };
}
```

### 3. **Update UI Inspector Files**

**Required Updates**:

#### A. **Task Key Inspector** (`task-key-inspector.html`)

Add missing fields that are currently only in dial inspector:

```html
<!-- ADD: Active Status Value -->
<sdpi-item label="Active Status Value">
  <sdpi-select setting="activeValue" disabled>
    <option value="">Loading values...</option>
  </sdpi-select>
  <sdpi-item-description
    >Select which status value represents an active/in-progress
    task.</sdpi-item-description
  >
</sdpi-item>

<!-- ADD: Pillar Property -->
<sdpi-item label="Pillar/Area Property">
  <sdpi-select setting="pillarProp" disabled>
    <option value="">Loading properties...</option>
  </sdpi-select>
  <sdpi-item-description
    >Select the property that categorizes tasks by pillar or area
    (optional).</sdpi-item-description
  >
</sdpi-item>

<!-- ADD: Project Property -->
<sdpi-item label="Project Property">
  <sdpi-select setting="projectProp" disabled>
    <option value="">Loading properties...</option>
  </sdpi-select>
  <sdpi-item-description
    >Select the property that categorizes tasks by project
    (optional).</sdpi-item-description
  >
</sdpi-item>
```

#### B. **New Priority Configuration Inspector**

Create a new section for priority system configuration:

```html
<!-- Priority System Configuration -->
<sdpi-item label="Priority Values">
  <sdpi-textarea
    setting="priorityValues"
    placeholder="High,Medium,Low"
  ></sdpi-textarea>
  <sdpi-item-description
    >Enter priority values in order from highest to lowest priority, separated
    by commas.</sdpi-item-description
  >
</sdpi-item>

<sdpi-item label="Meeting Filter">
  <sdpi-select setting="meetingFilterMode">
    <option value="priority">By Priority Value</option>
    <option value="keyword">By Keywords in Title</option>
    <option value="property">By Boolean Property</option>
    <option value="tag">By Tags/Multi-Select</option>
  </sdpi-select>
  <sdpi-item-description
    >Choose how to identify meeting tasks.</sdpi-item-description
  >
</sdpi-item>

<!-- Meeting Priority (shown when mode = "priority") -->
<sdpi-item label="Meeting Priority Value" class="meeting-priority-config">
  <sdpi-textfield
    setting="meetingPriorityValue"
    placeholder="Meeting"
  ></sdpi-textfield>
  <sdpi-item-description
    >Priority value that indicates meeting tasks.</sdpi-item-description
  >
</sdpi-item>

<!-- Meeting Keywords (shown when mode = "keyword") -->
<sdpi-item
  label="Meeting Keywords"
  class="meeting-keyword-config"
  style="display: none;"
>
  <sdpi-textarea
    setting="meetingKeywords"
    placeholder="meeting,call,standup,1:1"
  ></sdpi-textarea>
  <sdpi-item-description
    >Keywords that identify meeting tasks, separated by
    commas.</sdpi-item-description
  >
</sdpi-item>

<!-- Meeting Property (shown when mode = "property") -->
<sdpi-item
  label="Meeting Property"
  class="meeting-property-config"
  style="display: none;"
>
  <sdpi-select setting="meetingPropertyName" disabled>
    <option value="">Loading properties...</option>
  </sdpi-select>
  <sdpi-item-description
    >Boolean property that indicates meeting tasks.</sdpi-item-description
  >
</sdpi-item>

<!-- Meeting Tags (shown when mode = "tag") -->
<sdpi-item
  label="Meeting Tag Property"
  class="meeting-tag-config"
  style="display: none;"
>
  <sdpi-select setting="meetingTagProperty" disabled>
    <option value="">Loading properties...</option>
  </sdpi-select>
  <sdpi-item-description
    >Multi-select property containing meeting tags.</sdpi-item-description
  >
</sdpi-item>

<sdpi-item
  label="Meeting Tag Values"
  class="meeting-tag-values-config"
  style="display: none;"
>
  <sdpi-textarea
    setting="meetingTagValues"
    placeholder="meeting,call,standup"
  ></sdpi-textarea>
  <sdpi-item-description
    >Tag values that identify meetings, separated by
    commas.</sdpi-item-description
  >
</sdpi-item>
```

#### C. **Enhanced Dial Inspector**

Add priority and date filter configuration:

```html
<!-- ADD: Date Filter Configuration -->
<sdpi-item label="Date Filter">
  <sdpi-select setting="dateFilter">
    <!-- Default options (always available) -->
    <option value="today">Today</option>
    <option value="tomorrow">Tomorrow</option>
    <option value="weekly">This Week</option>
    <!-- Custom options dynamically added from dateFilterConfig.customFilters -->
  </sdpi-select>
  <sdpi-item-description
    >Choose which date range to display tasks for. Custom filters can be added
    in Advanced settings.</sdpi-item-description
  >
</sdpi-item>

<!-- ADD: Custom Date Filters Configuration (Advanced) -->
<sdpi-item label="Enable Custom Date Filters">
  <sdpi-checkbox setting="useCustomDateFilters"></sdpi-checkbox>
  <sdpi-item-description
    >Enable custom date ranges in addition to default
    options.</sdpi-item-description
  >
</sdpi-item>

<sdpi-item
  label="Custom Date Filters"
  class="custom-date-filters"
  style="display: none;"
>
  <sdpi-textarea
    setting="customDateFiltersJson"
    placeholder='[{"id":"next-sprint","label":"Next Sprint","startOffset":0,"endOffset":13}]'
  ></sdpi-textarea>
  <sdpi-item-description
    >JSON array of custom date filters. Each filter needs id, label,
    startOffset, and endOffset (days from today).</sdpi-item-description
  >
</sdpi-item>

<!-- ADD: Task Sorting -->
<sdpi-item label="Sort Tasks By">
  <sdpi-select setting="sortBy">
    <option value="priority">Priority</option>
    <option value="dueDate">Due Date</option>
    <option value="alphabetical">Alphabetical</option>
    <option value="custom">Custom Property</option>
  </sdpi-select>
  <sdpi-item-description
    >Choose how to sort tasks in the display.</sdpi-item-description
  >
</sdpi-item>
```

## Migration Strategy

### Phase 1: **Backwards Compatibility**

1. Keep existing hardcoded defaults as fallbacks
2. Add new configuration fields as optional
3. Ensure existing users' configurations continue to work

### Phase 2: **Enhanced Configuration**

1. Add UI fields for missing settings
2. Implement priority system configuration
3. Add meeting detection flexibility

### Phase 3: **Advanced Features**

1. Custom date filter configuration
2. Priority color customization UI
3. Advanced sorting options

## Testing Requirements

### 1. **Backwards Compatibility Testing**

- Existing configurations should continue to work without changes
- Default values should match current hardcoded behavior

### 2. **Priority System Testing**

Test different priority configurations:

- Standard: ["High", "Medium", "Low"]
- Numbered: ["P1", "P2", "P3", "P4"]
- Descriptive: ["Urgent", "Important", "Normal", "Someday"]
- Complex: ["🔥 Critical", "⚡ Urgent", "📅 Scheduled", "💡 Ideas"]

### 3. **Meeting Detection Testing**

Test all detection modes:

- Priority-based: Tasks with priority = "Meeting"
- Keyword-based: Tasks containing "meeting", "call", etc.
- Property-based: Tasks with isMatching checkbox = true

### 4. **Edge Case Testing**

- Empty/missing priority values
- Malformed configuration
- Database schema changes
- Network failures during property fetching

## User Documentation Requirements

### 1. **Migration Guide**

Document how existing users can:

- Update their priority configurations
- Map their existing priority values to new system
- Configure meeting detection for their workflow

### 2. **Configuration Examples**

Provide templates for common database schemas:

- GTD (Getting Things Done) methodology
- Agile/Scrum workflows
- Academic task management
- Personal productivity systems

### 3. **Troubleshooting Guide**

Common issues and solutions:

- Priority values not sorting correctly
- Meeting detection not working
- Color coding not appearing
- Database property loading failures

## Implementation Priority

### 🚨 **Critical (Must Fix)**

1. **Priority system configuration** - Blocks users with different priority values
2. **Missing UI fields for active features** - `pillarProp` and `projectProp` are actively used for categorization but not exposed in UI

### 🔶 **High (Should Fix)**

3. **Meeting filter system** - Replace single priority-based detection with flexible filtering
4. **Active value in all inspectors** - Consistency across UI

### 🔷 **Medium (Nice to Have)**

5. **Enhanced date filter system** - Keep defaults, add custom filter support
6. **Priority color configuration** - Visual customization

### 🔹 **Low (Future Enhancement)**

7. **Advanced sorting options** - Power user features
8. **Metrics display configuration** - Layout customization

This analysis provides a complete roadmap for making the Notion Tasks StreamDeck plugin generic and configurable for any user's database schema, with the priority system being the most critical issue to address first.
