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

import { type TaskSummary } from "../notion/task-helpers";
import { NotionClient } from "../notion/database-helpers";
import {
  getNotionTodaySummary,
  subscribeToNotionSummary,
  type NotionSettings,
} from "./notion-today";

const SUMMARY_LAYOUT_PATH = "layouts/active-summary.touch-layout.json";
const DETAIL_LAYOUT_PATH = "layouts/active-detail.touch-layout.json";

interface ContextState {
  id: string;
  action: DialAction<NotionSettings>;
  layoutApplied: boolean;
  unsubscribe?: () => void;
  currentTaskIndex: number;
  isInDetailMode: boolean;
  dialPressStartTime?: number;
  longPressTimeout?: NodeJS.Timeout;
}

const logger = streamDeck.logger.createScope("ActiveTasksDialAction");

const INITIAL_FEEDBACK = {
  heading: { value: "Active Tasks" },
  value: { value: "Loading..." },
  progress: 0,
} as const;

@action({ UUID: "com.tom-kregenbild.notion-tasks.active.dial" })
export class ActiveTasksDialAction extends SingletonAction<NotionSettings> {
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

    await this.ensureLayout(state);
    await action.setTitle("Active Tasks");
    await action.setFeedback({ ...INITIAL_FEEDBACK });

    // Reset to summary mode on appear
    state.isInDetailMode = false;
    state.currentTaskIndex = 0;

    const summary = getNotionTodaySummary();
    if (summary) {
      await this.updateFeedback(state, summary);
    }

    state.unsubscribe = subscribeToNotionSummary(latest => {
      if (!this.contexts.has(state.id)) return;
      if (!latest) return;
      const currentState = this.contexts.get(state.id);
      if (!currentState) return;
      
      if (currentState.isInDetailMode) {
        // In detail mode, update with current task
        void this.updateFeedbackWithCurrentTask(currentState, latest);
      } else {
        // In summary mode, update with summary
        void this.updateFeedback(currentState, latest);
      }
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
    this.contexts.delete(state.id);
  }

  override async onDialRotate(ev: DialRotateEvent<NotionSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onDialRotate:missing", { context: ev.action.id });
      return;
    }

    const summary = getNotionTodaySummary();
    if (!summary || !summary.activeTasks || summary.activeTasks.length === 0) {
      logger.debug("onDialRotate:noTasks", { context: state.id });
      return;
    }

    const direction = ev.payload.ticks > 0 ? "next" : "previous";
    const oldIndex = state.currentTaskIndex;
    const totalTasks = summary.activeTasks.length;

    if (!state.isInDetailMode) {
      // Currently in summary mode, enter detail mode
      state.isInDetailMode = true;
      state.currentTaskIndex = direction === "next" ? 0 : totalTasks - 1;
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
          logger.debug("onDialRotate:returnToSummary", { 
            context: state.id, 
            direction,
            totalTasks
          });
          // Switch back to summary layout
          await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
          await this.updateFeedback(state, summary);
          return;
        }
      } else {
        state.currentTaskIndex--;
        if (state.currentTaskIndex < 0) {
          // Before the first task, return to summary mode
          state.isInDetailMode = false;
          state.currentTaskIndex = 0;
          logger.debug("onDialRotate:returnToSummary", { 
            context: state.id, 
            direction,
            totalTasks
          });
          // Switch back to summary layout
          await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
          await this.updateFeedback(state, summary);
          return;
        }
      }
    }

    logger.debug("onDialRotate", { 
      context: state.id, 
      direction, 
      oldIndex, 
      newIndex: state.currentTaskIndex,
      totalTasks,
      isInDetailMode: state.isInDetailMode
    });

    await this.updateFeedbackWithCurrentTask(state, summary);
  }

  override async onTouchTap(ev: TouchTapEvent<NotionSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onTouchTap:missing", { context: ev.action.id });
      return;
    }

    // Only allow completing tasks when in detail mode
    if (!state.isInDetailMode) {
      logger.debug("onTouchTap:notInDetailMode", { context: state.id });
      return;
    }

    const summary = getNotionTodaySummary();
    if (!summary || !summary.activeTasks || summary.activeTasks.length === 0) {
      logger.debug("onTouchTap:noTasks", { context: state.id });
      return;
    }

    const currentTask = summary.activeTasks[state.currentTaskIndex];
    if (!currentTask) {
      logger.debug("onTouchTap:noCurrentTask", { context: state.id, index: state.currentTaskIndex });
      return;
    }

    const settings = ev.payload.settings ?? {};
    if (!settings.statusProp || !settings.doneValue) {
      logger.debug("onTouchTap:missingSettings", { 
        context: state.id, 
        hasStatusProp: !!settings.statusProp,
        hasDoneValue: !!settings.doneValue
      });
      return;
    }

    try {
      logger.debug("onTouchTap:markingTaskDone", { 
        context: state.id, 
        taskId: currentTask.id, 
        taskTitle: currentTask.title 
      });

      await this.markTaskDone(currentTask.id, settings);
      
      // After marking done, return to summary mode
      state.isInDetailMode = false;
      state.currentTaskIndex = 0;
      await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
      
      // Refresh the summary display
      const updatedSummary = getNotionTodaySummary();
      if (updatedSummary) {
        await this.updateFeedback(state, updatedSummary);
      }

      logger.debug("onTouchTap:taskMarkedDone", { 
        context: state.id, 
        taskId: currentTask.id 
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
        await this.switchToLayout(state, SUMMARY_LAYOUT_PATH);
        
        const summary = getNotionTodaySummary();
        if (summary) {
          await this.updateFeedback(state, summary);
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

  private async markTaskDone(taskId: string, settings: NotionSettings): Promise<void> {
    if (!settings.statusProp || !settings.doneValue || !settings.token) {
      throw new Error("Status property, done value, and token must be configured");
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
            status: { name: settings.doneValue },
          },
        },
      }),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("Retry-After")) || 1;
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      return this.markTaskDone(taskId, settings);
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

  private async updateFeedback(state: ContextState, summary: TaskSummary): Promise<void> {
    const active = summary.active ?? 0;
    const total = summary.total ?? 0;
    const completedRaw = summary.completed ?? Math.max(total - active, 0);
    const completed = Math.min(Math.max(completedRaw, 0), total);
    const ratio = total > 0 ? clampRatio(completed / total) : 0;
    const title = total > 0 ? `${active} active of ${total}` : `${active} active`;

    logger.trace("feedback:update", {
      context: state.id,
      active,
      total,
      completed,
      ratio,
    });

    await state.action.setFeedback({
      heading: { value: "Active Tasks" },
      value: { value: `${active} / ${total}` },
      progress: ratio,
    });
    await state.action.setTitle(title);
  }

  private async updateFeedbackWithCurrentTask(state: ContextState, summary: TaskSummary): Promise<void> {
    if (!summary.activeTasks || summary.activeTasks.length === 0) {
      await this.updateFeedback(state, summary);
      return;
    }

    const currentTask = summary.activeTasks[state.currentTaskIndex];
    if (!currentTask) {
      await this.updateFeedback(state, summary);
      return;
    }

    const taskPosition = `${state.currentTaskIndex + 1}/${summary.activeTasks.length}`;
    const taskNameParts = this.formatTaskNameTwoLines(currentTask.title);
    
    logger.trace("feedback:updateWithTask", {
      context: state.id,
      taskIndex: state.currentTaskIndex,
      taskTitle: currentTask.title,
      taskPosition,
      taskNameParts,
    });

    await state.action.setFeedback({
      heading: { value: `Task ${taskPosition}` },
      value: { value: taskNameParts.line1 },
      value2: { value: taskNameParts.line2 },
      time: { value: currentTask.priority || "" },
    });
    await state.action.setTitle(`Task: ${taskNameParts.line1}`);
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
