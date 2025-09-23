import {
  SingletonAction,
  action,
  type DialAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
} from "@elgato/streamdeck";

import streamDeck from "@elgato/streamdeck";

import { type NotionTask } from "../notion/task-helpers";
import { NotionClient } from "../notion/database-helpers";
import {
  getNotionTodaySummary,
  subscribeToNotionSummary,
  type NotionSettings,
} from "./notion-today";

const LAYOUT_PATH = "layouts/next-meeting.touch-layout.json";

interface ContextState {
  id: string;
  action: DialAction<NotionSettings>;
  layoutApplied: boolean;
  unsubscribe?: () => void;
}

const logger = streamDeck.logger.createScope("NextMeetingDialAction");

const INITIAL_FEEDBACK = {
  heading: { value: "Next Meeting" },
  value: { value: "Loading..." },
  progress: 0,
} as const;

@action({ UUID: "com.tom-kregenbild.notion-tasks.next-meeting.dial" })
export class NextMeetingDialAction extends SingletonAction<NotionSettings> {
  private readonly contexts = new Map<string, ContextState>();

  override async onWillAppear(ev: WillAppearEvent<NotionSettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<NotionSettings>;
    const state: ContextState = {
      id: action.id,
      action,
      layoutApplied: false,
    };
    this.contexts.set(state.id, state);

    logger.debug("onWillAppear", { context: state.id });

    await this.ensureLayout(state);
    await action.setTitle("Next Meeting");
    await action.setFeedback({ ...INITIAL_FEEDBACK });

    const summary = getNotionTodaySummary();
    if (summary) {
      await this.updateFeedback(state, summary);
    }

    state.unsubscribe = subscribeToNotionSummary(latest => {
      if (!this.contexts.has(state.id)) return;
      if (!latest) return;
      void this.updateFeedback(state, latest);
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

  private async ensureLayout(state: ContextState): Promise<void> {
    if (state.layoutApplied) {
      return;
    }

    try {
      logger.trace("layout:apply", { context: state.id, layout: LAYOUT_PATH });
      await state.action.setFeedbackLayout(LAYOUT_PATH);
      state.layoutApplied = true;
      logger.trace("layout:applied", { context: state.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("layout:error", { context: state.id, layout: LAYOUT_PATH, message });
    }
  }

  private async updateFeedback(state: ContextState, summary: any): Promise<void> {
    const settings = await state.action.getSettings();
    const nextMeeting = this.getNextMeetingWithTime(summary, settings);
    
    if (!nextMeeting) {
      await state.action.setFeedback({
        heading: { value: "Next Meeting" },
        value: { value: "No meetings" },
        progress: 0,
      });
      await state.action.setTitle("No meetings");
      return;
    }

    const meetingName = this.formatMeetingName(nextMeeting.title || "Untitled Meeting");
    const timeInfo = this.formatTimeInfo(nextMeeting.due);
    
    logger.trace("feedback:update", {
      context: state.id,
      meetingName,
      timeInfo,
      due: nextMeeting.due,
    });

    await state.action.setFeedback({
      heading: { value: "Next Meeting" },
      value: { value: meetingName },
      progress: this.calculateMeetingProgress(nextMeeting.due),
    });
    
    await state.action.setTitle(timeInfo || meetingName);
  }

  private getNextMeetingWithTime(summary: any, settings: NotionSettings): NotionTask | undefined {
    if (!summary || !summary.activeTasks) return undefined;
    
    const meetingPriorityValue = settings.meetingPriority || "Meeting";
    
    // Filter tasks that are meetings with time specified and not yet passed
    const now = new Date();
    const meetings = summary.activeTasks.filter((task: NotionTask) => {
      // Check if task has the meeting priority value
      if (!task.priority || task.priority !== meetingPriorityValue) {
        return false;
      }
      
      // Check if task has a due date/time
      if (!task.due) {
        return false;
      }
      
      // Check if the meeting hasn't passed yet
      const meetingTime = new Date(task.due);
      return meetingTime > now;
    });
    
    // Sort by due date and return the earliest
    if (meetings.length === 0) return undefined;
    
    meetings.sort((a: NotionTask, b: NotionTask) => {
      const dateA = new Date(a.due!);
      const dateB = new Date(b.due!);
      return dateA.getTime() - dateB.getTime();
    });
    
    return meetings[0];
  }

  private formatMeetingName(name: string): string {
    // Truncate long meeting names to fit on the dial
    const maxLength = 20;
    if (name.length <= maxLength) {
      return name;
    }
    return name.substring(0, maxLength - 3) + "...";
  }

  private formatTimeInfo(due?: string): string {
    if (!due) return "";
    
    const meetingTime = new Date(due);
    const now = new Date();
    
    // Check if it's today
    const isToday = meetingTime.toDateString() === now.toDateString();
    
    if (isToday) {
      return meetingTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      // Show date and time for future dates
      return meetingTime.toLocaleDateString([], { month: 'short', day: 'numeric' }) + 
             " " + meetingTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
  }

  private calculateMeetingProgress(due?: string): number {
    if (!due) return 0;
    
    const meetingTime = new Date(due);
    const now = new Date();
    
    // Calculate progress based on how close we are to the meeting
    // If meeting is within 1 hour, show progress bar based on proximity
    const timeDiff = meetingTime.getTime() - now.getTime();
    const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds
    
    if (timeDiff <= 0) return 1; // Meeting has passed
    if (timeDiff >= oneHour) return 0; // More than 1 hour away
    
    // Linear progress from 0 to 1 as we approach the meeting time
    return 1 - (timeDiff / oneHour);
  }
}