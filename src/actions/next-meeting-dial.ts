import {
  SingletonAction,
  action,
  type DialAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type DialRotateEvent,
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
  currentMeetingIndex: number;
  todaysMeetings: NotionTask[];
}

const logger = streamDeck.logger.createScope("NextMeetingDialAction");

const INITIAL_FEEDBACK = {
  heading: { value: "Next Meeting" },
  value: { value: "Loading..." },
  value2: { value: "" },
  time: { value: "" },
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
      currentMeetingIndex: 0,
      todaysMeetings: [],
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

  override async onDialRotate(ev: DialRotateEvent<NotionSettings>): Promise<void> {
    const state = this.contexts.get(ev.action.id);
    if (!state) {
      logger.debug("onDialRotate:missing", { context: ev.action.id });
      return;
    }

    if (state.todaysMeetings.length === 0) {
      logger.debug("onDialRotate:noMeetings", { context: state.id });
      return;
    }

    if (state.todaysMeetings.length === 1) {
      logger.debug("onDialRotate:singleMeeting", { context: state.id });
      return;
    }

    const direction = ev.payload.ticks > 0 ? "next" : "previous";
    const oldIndex = state.currentMeetingIndex;

    if (direction === "next") {
      // Turn right: go to next meeting
      state.currentMeetingIndex = (state.currentMeetingIndex + 1) % state.todaysMeetings.length;
    } else {
      // Turn left: go to previous meeting
      state.currentMeetingIndex = state.currentMeetingIndex === 0 
        ? state.todaysMeetings.length - 1 
        : state.currentMeetingIndex - 1;
    }

    logger.debug("onDialRotate", { 
      context: state.id, 
      direction, 
      oldIndex, 
      newIndex: state.currentMeetingIndex,
      totalMeetings: state.todaysMeetings.length
    });

    await this.updateFeedbackWithCurrentMeeting(state);
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
    const todaysMeetings = this.getTodaysMeetings(summary, settings);
    
    // Update the state with today's meetings
    state.todaysMeetings = todaysMeetings;
    state.currentMeetingIndex = 0; // Reset to first meeting
    
    if (todaysMeetings.length === 0) {
      await state.action.setFeedback({
        heading: { value: "Next Meeting" },
        value: { value: "No meetings" },
        value2: { value: "" },
        time: { value: "" },
      });
      await state.action.setTitle("No meetings");
      return;
    }

    await this.updateFeedbackWithCurrentMeeting(state);
  }

  private async updateFeedbackWithCurrentMeeting(state: ContextState): Promise<void> {
    if (state.todaysMeetings.length === 0) {
      await state.action.setFeedback({
        heading: { value: "Next Meeting" },
        value: { value: "No meetings" },
        value2: { value: "" },
        time: { value: "" },
      });
      await state.action.setTitle("No meetings");
      return;
    }

    const currentMeeting = state.todaysMeetings[state.currentMeetingIndex];
    const meetingNameParts = this.formatMeetingNameTwoLines(currentMeeting.title || "Untitled Meeting");
    const timeDisplay = this.formatTimeDisplay(currentMeeting);
    
    // Create heading text that shows current position if multiple meetings
    const headingText = state.todaysMeetings.length > 1 
      ? `Meeting ${state.currentMeetingIndex + 1}/${state.todaysMeetings.length}`
      : "Next Meeting";
    
    logger.trace("feedback:update", {
      context: state.id,
      meetingIndex: state.currentMeetingIndex,
      totalMeetings: state.todaysMeetings.length,
      meetingName: meetingNameParts,
      timeDisplay,
      startTime: currentMeeting.startTime,
      endTime: currentMeeting.endTime,
      due: currentMeeting.due,
    });

    await state.action.setFeedback({
      heading: { value: headingText },
      value: { value: meetingNameParts.line1 },
      value2: { value: meetingNameParts.line2 },
      time: { value: timeDisplay },
    });
    
    await state.action.setTitle(timeDisplay || meetingNameParts.line1);
  }

  private getTodaysMeetings(summary: any, settings: NotionSettings): NotionTask[] {
    if (!summary || !summary.activeTasks) return [];
    
    const meetingPriorityValue = settings.meetingPriority || "Meeting";
    
    // Filter tasks that are meetings with time specified and are today or future
    const now = new Date();
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    
    const meetings = summary.activeTasks.filter((task: NotionTask) => {
      // Check if task has the meeting priority value
      if (!task.priority || task.priority !== meetingPriorityValue) {
        return false;
      }
      
      // Check if task has a due date/time (use startTime if available, fallback to due)
      const meetingStart = task.startTime || task.due;
      if (!meetingStart) {
        return false;
      }
      
      // Check if the meeting is today or in the future
      const meetingTime = new Date(meetingStart);
      return meetingTime >= startOfToday;
    });
    
    // Sort by due date (earliest first)
    meetings.sort((a: NotionTask, b: NotionTask) => {
      const dateA = new Date(a.startTime || a.due!);
      const dateB = new Date(b.startTime || b.due!);
      return dateA.getTime() - dateB.getTime();
    });
    
    return meetings;
  }

  private formatMeetingNameTwoLines(name: string): { line1: string; line2: string } {
    // Split long meeting names across two lines
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

  private formatTimeDisplay(task: NotionTask): string {
    const startTime = task.startTime || task.due;
    if (!startTime) return "";
    
    const start = new Date(startTime);
    const now = new Date();
    
    // Check if it's today
    const isToday = start.toDateString() === now.toDateString();
    
    // Format start time
    const startTimeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    // Check if we have an end time
    if (task.endTime) {
      const end = new Date(task.endTime);
      const endTimeStr = end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      // Check if start and end are on the same day
      const sameDay = start.toDateString() === end.toDateString();
      
      if (isToday && sameDay) {
        // Today, same day: "2:30-3:30 PM"
        return `${startTimeStr}-${endTimeStr}`;
      } else if (sameDay) {
        // Future date, same day: "Dec 25 2:30-3:30 PM"
        const dateStr = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `${dateStr} ${startTimeStr}-${endTimeStr}`;
      } else {
        // Different days: show start date and time only for now
        if (isToday) {
          return `${startTimeStr} (${this.calculateDuration(start, end)})`;
        } else {
          const dateStr = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
          return `${dateStr} ${startTimeStr} (${this.calculateDuration(start, end)})`;
        }
      }
    } else {
      // No end time, just show start
      if (isToday) {
        return startTimeStr;
      } else {
        const dateStr = start.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `${dateStr} ${startTimeStr}`;
      }
    }
  }

  private calculateDuration(start: Date, end: Date): string {
    const diffMs = end.getTime() - start.getTime();
    const diffMinutes = Math.round(diffMs / (1000 * 60));
    
    if (diffMinutes < 60) {
      return `${diffMinutes}m`;
    } else {
      const hours = Math.floor(diffMinutes / 60);
      const minutes = diffMinutes % 60;
      if (minutes === 0) {
        return `${hours}h`;
      } else {
        return `${hours}h${minutes}m`;
      }
    }
  }
}