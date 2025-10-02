import {
  SingletonAction,
  action,
  type DialAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type DialRotateEvent,
  type TouchTapEvent,
  type DialDownEvent,
  type DialUpEvent,
} from "@elgato/streamdeck";

import streamDeck from "@elgato/streamdeck";

import { type TaskSummary, type NotionTask } from "../notion/task-helpers";
import { NotionClient } from "../notion/database-helpers";
import {
  getNotionTodaySummary,
  getNotionTasksWithDateFilter,
  subscribeToNotionSummary,
  refreshNotionData,
  type NotionSettings,
} from "./notion-today";
import { globalSettingsManager } from "../notion/global-settings";

const SUMMARY_LAYOUT_PATH = "layouts/complete-summary.touch-layout.json";
const DETAIL_LAYOUT_PATH = "layouts/complete-detail.touch-layout.json";

interface ContextState {
  id: string;
  action: DialAction<NotionSettings>;
  layoutApplied: boolean;
  unsubscribe?: () => void;
  currentTaskIndex: number;
  isInDetailMode: boolean;
  dialPressStartTime?: number;
  longPressTimeout?: NodeJS.Timeout;
  currentTaskStatusOverride?: string; // Store temporary status override for immediate feedback
}

const logger = streamDeck.logger.createScope("CompleteTasksDialAction");

// Persistent cache for date-filtered summaries to avoid repeated API calls during dial rotations
const dateFilterCache = new Map<string, { 
  summary: TaskSummary; 
  timestamp: number; 
  pendingRefresh?: Promise<TaskSummary | undefined>;
}>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minute cache - longer duration for better performance
const REFRESH_THRESHOLD = 30 * 1000; // Refresh if older than 30 seconds but still serve cached data

// Helper function to get filtered task summary based on date filter setting
async function getFilteredTaskSummaryAsync(settings: NotionSettings): Promise<TaskSummary | undefined> {
  const dateFilter = settings.dateFilter || "today";
  
  logger.debug("getFilteredTaskSummaryAsync start", {
    dateFilter
  });
  
  // For "today", use the existing cached summary for better performance
  if (dateFilter === "today") {
    return getNotionTodaySummary();
  }
  
  // Check cache for non-today filters
  const cacheKey = `${settings.db}-${settings.token}-${dateFilter}`;
  const cached = dateFilterCache.get(cacheKey);
  const now = Date.now();
  
  // If we have fresh cached data, return it immediately
  if (cached && (now - cached.timestamp) < CACHE_DURATION) {
    logger.debug("getFilteredTaskSummaryAsync cache hit", {
      dateFilter,
      cacheAge: now - cached.timestamp,
      isStale: (now - cached.timestamp) > REFRESH_THRESHOLD
    });
    
    // If data is getting stale but still valid, trigger background refresh
    if ((now - cached.timestamp) > REFRESH_THRESHOLD && !cached.pendingRefresh) {
      logger.debug("getFilteredTaskSummaryAsync triggering background refresh", { dateFilter });
      cached.pendingRefresh = refreshDateFilterCache(settings, cacheKey);
    }
    
    return cached.summary;
  }
  
  // No valid cache, need to fetch immediately
  return await refreshDateFilterCache(settings, cacheKey);
}

// Separate function to handle cache refresh
async function refreshDateFilterCache(settings: NotionSettings, cacheKey: string): Promise<TaskSummary | undefined> {
  const dateFilter = settings.dateFilter || "today";
  const cached = dateFilterCache.get(cacheKey);
  
  // If there's already a refresh in progress, wait for it
  if (cached?.pendingRefresh) {
    logger.debug("refreshDateFilterCache waiting for existing refresh", { dateFilter });
    return await cached.pendingRefresh;
  }
  
  // Start a new refresh
  const refreshPromise = (async (): Promise<TaskSummary | undefined> => {
    try {
      logger.debug("refreshDateFilterCache fetching from API", { dateFilter });
      
      const summary = await getNotionTasksWithDateFilter(settings);
      const now = Date.now();
      
      // Update cache with new data
      if (summary) {
        dateFilterCache.set(cacheKey, { 
          summary, 
          timestamp: now,
          // Don't carry over the pendingRefresh promise
        });
        logger.debug("refreshDateFilterCache cached fresh result", {
          dateFilter,
          active: summary.active,
          total: summary.total
        });
      }
      
      return summary;
    } catch (error) {
      logger.error("refreshDateFilterCache error", {
        dateFilter,
        error: error instanceof Error ? error.message : String(error)
      });
      
      // Clear the pending refresh on error
      const currentCached = dateFilterCache.get(cacheKey);
      if (currentCached) {
        delete currentCached.pendingRefresh;
      }
      
      return undefined;
    }
  })();
  
  // Store the pending refresh
  const currentCached = dateFilterCache.get(cacheKey);
  if (currentCached) {
    currentCached.pendingRefresh = refreshPromise;
  } else {
    dateFilterCache.set(cacheKey, {
      summary: { active: 0, total: 0, completed: 0, activeTasks: [], completedTasks: [], meetingPriority: "", generatedAt: Date.now() },
      timestamp: 0, // Will be updated when refresh completes
      pendingRefresh: refreshPromise
    });
  }
  
  return await refreshPromise;
}

// Function to clear cache when data is refreshed - now more selective
function clearDateFilterCache(specificKey?: string): void {
  if (specificKey) {
    // Only clear specific cache entry
    if (dateFilterCache.delete(specificKey)) {
      logger.debug("Date filter cache cleared for specific key", { key: specificKey });
    }
  } else {
    // Clear all cache entries
    dateFilterCache.clear();
    logger.debug("Date filter cache completely cleared");
  }
}

// Function to invalidate cache but keep serving stale data during refresh
function invalidateCache(cacheKey: string): void {
  const cached = dateFilterCache.get(cacheKey);
  if (cached) {
    // Mark as stale by setting timestamp to 0, but keep the summary for immediate serving
    cached.timestamp = 0;
    logger.debug("Date filter cache invalidated", { key: cacheKey });
  }
}

const INITIAL_FEEDBACK = {
  heading: { value: "Tasks" },
  value: { value: "Loading..." },
  progress: 0,
} as const;

@action({ UUID: "com.tom-kregenbild.notion-tasks.complete.dial" })
export class CompleteTasksDialAction extends SingletonAction<NotionSettings> {
  private readonly contexts = new Map<string, ContextState>();

  override async onWillAppear(ev: WillAppearEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<NotionSettings>;
    const state: ContextState = {
      id: action.id,
      action,
      layoutApplied: false,
      currentTaskIndex: 0,
      isInDetailMode: false,
    };
    this.contexts.set(state.id, state);

    logger.debug("onWillAppear", { context: state.id });

    // Register with global settings manager
    globalSettingsManager.registerContext(state.id);

    await this.ensureLayout(state);
    await action.setTitle("Tasks");
    await action.setFeedback({ ...INITIAL_FEEDBACK });

    // Reset to summary mode on appear
    state.isInDetailMode = false;
    state.currentTaskIndex = 0;

    const settings = ev.payload.settings ?? {};
    
    // Update global settings from current settings
    globalSettingsManager.updateFromSettings(state.id, settings);
    const summary = await getFilteredTaskSummaryAsync(settings);
    if (summary) {
      await this.updateFeedback(state, summary, settings);
    }

    state.unsubscribe = subscribeToNotionSummary(latest => {
      if (!this.contexts.has(state.id)) return;
      if (!latest) return;
      const currentState = this.contexts.get(state.id);
      if (!currentState) return;
      
      // Get current settings for filtering
      currentState.action.getSettings().then(async currentSettings => {
        // Only invalidate cache for non-today filters when new "today" data comes in
        // This allows Tomorrow/Next Week to stay cached longer for better performance
        const dateFilter = currentSettings.dateFilter || "today";
        if (dateFilter !== "today") {
          const cacheKey = `${currentSettings.db}-${currentSettings.token}-${dateFilter}`;
          invalidateCache(cacheKey);
        }
        
        const filteredSummary = await getFilteredTaskSummaryAsync(currentSettings);
        if (!filteredSummary) return;
        
        if (currentState.isInDetailMode) {
          // In detail mode, update with current task (show completed tasks)
          void this.updateFeedbackWithCurrentTask(currentState, filteredSummary, currentSettings);
        } else {
          // In summary mode, update with summary
          void this.updateFeedback(currentState, filteredSummary, currentSettings);
        }
      });
    });
  }

  override onWillDisappear(ev: WillDisappearEvent<NotionSettings>): void {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onWillDisappear:missing", { context: ev.action.id });
      return;
    }

    logger.debug("onWillDisappear", { context: state.id });
    state.unsubscribe?.();
    
    // Unregister from global settings manager
    globalSettingsManager.unregisterContext(state.id);
    
    this.contexts.delete(state.id);
  }

  override async onDialRotate(ev: DialRotateEvent<NotionSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onDialRotate:missing", { context: ev.action.id });
      return;
    }

    const settings = ev.payload.settings ?? {};
    const startTime = Date.now();
    const summary = await getFilteredTaskSummaryAsync(settings);
    const fetchTime = Date.now() - startTime;
    
    logger.debug("onDialRotate:dataFetch", { 
      context: state.id, 
      dateFilter: settings.dateFilter || "today",
      fetchTime: `${fetchTime}ms`,
      hasSummary: !!summary
    });
    // Show all tasks (both active and completed)
    const allTasks = [...(summary?.activeTasks || []), ...(summary?.completedTasks || [])];
    if (!summary || allTasks.length === 0) {
      logger.debug("onDialRotate:noTasks", { context: state.id });
      return;
    }

    const direction = ev.payload.ticks > 0 ? "next" : "previous";
    const oldIndex = state.currentTaskIndex;
    const totalTasks = allTasks.length;

    if (!state.isInDetailMode) {
      // Currently in summary mode, enter detail mode
      state.isInDetailMode = true;
      state.currentTaskIndex = direction === "next" ? 0 : totalTasks - 1;
      state.currentTaskStatusOverride = undefined; // Clear any status override when entering detail mode
      // Switch to detail layout
      await this.switchToLayout(state, DETAIL_LAYOUT_PATH);
    } else {
      // Currently in detail mode, navigate through tasks
      if (direction === "next") {
        state.currentTaskIndex++;
        if (state.currentTaskIndex >= totalTasks) {
          // Past the last task, return to summary mode
          state.isInDetailMode = false;
          state.currentTaskIndex = 0;
          state.currentTaskStatusOverride = undefined; // Clear status override when returning to summary
          logger.debug("onDialRotate:returnToSummary", { 
            context: state.id, 
            direction,
            totalTasks
          });
          // Switch back to summary layout
          await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
          await this.updateFeedback(state, summary, settings);
          return;
        }
      } else {
        state.currentTaskIndex--;
        if (state.currentTaskIndex < 0) {
          // Before the first task, return to summary mode
          state.isInDetailMode = false;
          state.currentTaskIndex = 0;
          state.currentTaskStatusOverride = undefined; // Clear status override when returning to summary
          logger.debug("onDialRotate:returnToSummary", { 
            context: state.id, 
            direction,
            totalTasks
          });
          // Switch back to summary layout
          await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
          await this.updateFeedback(state, summary, settings);
          return;
        }
      }
      // Clear status override when navigating to a different task
      state.currentTaskStatusOverride = undefined;
    }

    logger.debug("onDialRotate", { 
      context: state.id, 
      direction, 
      oldIndex, 
      newIndex: state.currentTaskIndex,
      totalTasks,
      isInDetailMode: state.isInDetailMode
    });

    await this.updateFeedbackWithCurrentTask(state, summary, settings);
  }

  override async onTouchTap(ev: TouchTapEvent<NotionSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onTouchTap:missing", { context: ev.action.id });
      return;
    }

    // Only allow toggling tasks when in detail mode
    if (!state.isInDetailMode) {
      logger.debug("onTouchTap:notInDetailMode", { context: state.id });
      return;
    }

    const settings = ev.payload.settings ?? {};
    const summary = await getFilteredTaskSummaryAsync(settings);
    const allTasks = [...(summary?.activeTasks || []), ...(summary?.completedTasks || [])];
    if (!summary || allTasks.length === 0) {
      logger.debug("onTouchTap:noTasks", { context: state.id });
      return;
    }

    const currentTask = allTasks[state.currentTaskIndex];
    if (!currentTask) {
      logger.debug("onTouchTap:noCurrentTask", { context: state.id, index: state.currentTaskIndex });
      return;
    }

    if (!settings.statusProp || !settings.activeValue || !settings.doneValue) {
      logger.debug("onTouchTap:missingSettings", { 
        context: state.id, 
        hasStatusProp: !!settings.statusProp,
        hasActiveValue: !!settings.activeValue,
        hasDoneValue: !!settings.doneValue
      });
      return;
    }

    try {
      // Determine if task is currently completed or active
      const isCurrentlyCompleted = this.isTaskCompleted(currentTask, settings.doneValue);
      const targetStatus = isCurrentlyCompleted ? settings.activeValue : settings.doneValue;
      const action = isCurrentlyCompleted ? "activating" : "completing";

      logger.debug(`onTouchTap:${action}Task`, { 
        context: state.id, 
        taskId: currentTask.id, 
        taskTitle: currentTask.title,
        currentStatus: currentTask.status,
        targetStatus
      });

      await this.updateTaskStatus(currentTask.id, settings, targetStatus);
      
      // Invalidate cache for current date filter since task status changed
      const dateFilter = settings.dateFilter || "today";
      if (dateFilter !== "today") {
        const cacheKey = `${settings.db}-${settings.token}-${dateFilter}`;
        invalidateCache(cacheKey);
      }
      
      // Stay in detail view and immediately update the display
      // Store the new status in the state for immediate feedback
      state.currentTaskStatusOverride = targetStatus;
      
      // Immediately refresh the display with the updated status
      await this.updateFeedbackWithCurrentTask(state, summary, settings);

      logger.debug(`onTouchTap:task${action.charAt(0).toUpperCase() + action.slice(1)}d`, { 
        context: state.id, 
        taskId: currentTask.id,
        newStatus: targetStatus
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

  override async onDialDown(ev: DialDownEvent<NotionSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onDialDown:missing", { context: ev.action.id });
      return;
    }
    
    // Clear any existing timeout
    if (state.longPressTimeout) {
      clearTimeout(state.longPressTimeout);
    }
    
    // Record the start time for long press detection
    state.dialPressStartTime = Date.now();
    
    // Only set up long press timeout if we're in detail mode
    if (state.isInDetailMode) {
      const longPressThreshold = 1000; // 1 second
      
      state.longPressTimeout = setTimeout(async () => {
        // Long press triggered - automatically return to summary
        logger.debug("onDialDown:longPressTriggered", { context: state.id });
        
        state.isInDetailMode = false;
        state.currentTaskIndex = 0;
        state.currentTaskStatusOverride = undefined; // Clear status override when returning to summary
        await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
        
        // Refresh all plugin data before updating the display
        logger.debug("onDialDown:refreshingData", { context: state.id });
        
        // Only clear cache for the current date filter when doing a manual refresh
        const refreshSettings = await state.action.getSettings();
        const dateFilter = refreshSettings.dateFilter || "today";
        if (dateFilter !== "today") {
          const cacheKey = `${refreshSettings.db}-${refreshSettings.token}-${dateFilter}`;
          clearDateFilterCache(cacheKey);
        }
        
        await refreshNotionData(true);
        
        const currentSettings = await state.action.getSettings();
        const summary = await getFilteredTaskSummaryAsync(currentSettings);
        if (summary) {
          await this.updateFeedback(state, summary, currentSettings);
        }
        
        // Clear the timeout reference
        state.longPressTimeout = undefined;
      }, longPressThreshold);
    }
    
    logger.debug("onDialDown:triggered", { 
      context: ev.action.id, 
      startTime: state.dialPressStartTime,
      setTimer: state.isInDetailMode
    });
  }

  override async onDialUp(ev: DialUpEvent<NotionSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onDialUp:missing", { context: ev.action.id });
      return;
    }

    const endTime = Date.now();
    const pressDuration = state.dialPressStartTime ? endTime - state.dialPressStartTime : 0;
    const longPressThreshold = 1000; // 1 second
    
    logger.debug("onDialUp:triggered", { 
      context: ev.action.id, 
      pressDuration,
      hadTimeout: !!state.longPressTimeout
    });

    // Clear the press start time and timeout
    state.dialPressStartTime = undefined;
    
    if (state.longPressTimeout) {
      // Cancel the long press timeout - it didn't trigger
      clearTimeout(state.longPressTimeout);
      state.longPressTimeout = undefined;
      
      // Since we cancelled the timeout, this was a short press
      if (pressDuration < longPressThreshold) {
        logger.debug("onDialUp:shortPress", { context: state.id });
        await this.onTouchTap(ev as any);
      }
    } else {
      // No timeout was set (not in detail mode) or timeout already triggered
      // If no timeout was set and it's a short press, execute tap action
      if (pressDuration < longPressThreshold) {
        logger.debug("onDialUp:shortPressNoDetail", { context: state.id });
        await this.onTouchTap(ev as any);
      }
    }
  }

  private isTaskCompleted(task: NotionTask, doneValue: string): boolean {
    if (!task.status) return false;
    return this.normalizeComparable(task.status) === this.normalizeComparable(doneValue);
  }

  private normalizeComparable(value?: string): string {
    return (value ?? "").trim().toLowerCase();
  }

  private async updateTaskStatus(taskId: string, settings: NotionSettings, statusValue: string): Promise<void> {
    if (!settings.statusProp || !settings.token) {
      throw new Error("Status property and token must be configured");
    }

    const headers = {
      Authorization: `Bearer ${settings.token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    };

    const res = await fetch(`https://api.notion.com/v1/pages/${taskId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        properties: {
          [settings.statusProp]: {
            status: { name: statusValue },
          },
        },
      }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 1;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return this.updateTaskStatus(taskId, settings, statusValue);
    }
    
    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Notion update failed ${res.status}: ${errorText}`);
    }
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<NotionSettings>;
    const settings = ev.payload.settings ?? {};
    
    logger.debug("Received settings update", { 
      context: action.id,
      hasTrigger: !!settings._triggerPropertyFetch,
      hasToken: !!settings.token,
      hasDb: !!settings.db,
      hasProperties: !!settings._dbProperties
    });

    // Update global settings when any settings change
    globalSettingsManager.updateFromSettings(action.id, settings);
    
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

  private async updateFeedback(state: ContextState, summary: TaskSummary, settings?: NotionSettings): Promise<void> {
    const active = summary.active ?? 0;
    const total = summary.total ?? 0;
    const completedRaw = summary.completed ?? Math.max(total - active, 0);
    const completed = Math.min(Math.max(completedRaw, 0), total);
    const ratio = total > 0 ? clampRatio(completed / total) : 0;
    const title = total > 0 ? `${completed} complete of ${total}` : `${completed} complete`;

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

    logger.trace("feedback:update", {
      context: state.id,
      active,
      total,
      completed,
      ratio,
      dateFilter,
      heading,
    });

    await state.action.setFeedback({
      heading: { value: heading },
      value: { value: `${completed} / ${total}` },
      progress: ratio,
    });
    await state.action.setTitle(title);
  }

  private async updateFeedbackWithCurrentTask(state: ContextState, summary: TaskSummary, settings?: NotionSettings): Promise<void> {
    const allTasks = [...(summary.activeTasks || []), ...(summary.completedTasks || [])];
    if (allTasks.length === 0) {
      await this.updateFeedback(state, summary, settings);
      return;
    }

    const currentTask = allTasks[state.currentTaskIndex];
    if (!currentTask) {
      await this.updateFeedback(state, summary, settings);
      return;
    }

    const currentSettings = settings || await state.action.getSettings();
    // Use status override if available, otherwise use actual task status
    const effectiveStatus = state.currentTaskStatusOverride || currentTask.status;
    const isCompleted = this.isTaskCompleted({ ...currentTask, status: effectiveStatus }, String(currentSettings.doneValue || ""));
    const taskPosition = `${state.currentTaskIndex + 1}/${allTasks.length}`;
    const taskNameParts = this.formatTaskNameTwoLines(currentTask.title);
    const statusIndicator = isCompleted ? "✓" : "○";
    const actionHint = isCompleted ? "Tap: Mark Active" : "Tap: Mark Done";
    
    logger.trace("feedback:updateWithTask", {
      context: state.id,
      taskIndex: state.currentTaskIndex,
      taskTitle: currentTask.title,
      originalStatus: currentTask.status,
      effectiveStatus: effectiveStatus,
      taskPosition,
      taskNameParts,
      isCompleted,
      statusIndicator,
      actionHint,
    });

    await state.action.setFeedback({
      heading: { value: `${statusIndicator} Task ${taskPosition}` },
      value: { value: taskNameParts.line1 },
      value2: { value: taskNameParts.line2 },
      time: { value: actionHint },
    });
    await state.action.setTitle(`${statusIndicator} ${taskNameParts.line1}`);
  }

  private formatTaskNameTwoLines(name: string): { line1: string; line2: string } {
    // Split long task names across two lines
    const maxLineLength = 20;
    
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

  private truncateTitle(title: string, maxLength: number = 20): string {
    if (title.length <= maxLength) {
      return title;
    }
    return title.substring(0, maxLength - 3) + "...";
  }
}

function clampRatio(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}