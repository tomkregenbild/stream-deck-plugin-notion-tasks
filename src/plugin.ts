import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { CompleteTasksDialAction } from "./actions/complete-tasks-dial";
import { NotionTodayAction } from "./actions/notion-today";
import { NextMeetingDialAction } from "./actions/next-meeting-dial";
import { NotionHabitAction } from "./actions/notion-habit";
import { HabitDialAction } from "./actions/habit-dial";
import { autoRefreshManager, createTaskDataSource, createHabitDataSource } from "./notion/auto-refresh";
import { refreshNotionData } from "./actions/notion-today";

// Set logging level to DEBUG to show useful debugging info while avoiding TRACE level 
// that logs sensitive data like tokens and database IDs in settings objects
streamDeck.logger.setLevel(LogLevel.DEBUG);

// Register the Notion Today action.
streamDeck.actions.registerAction(new NotionTodayAction());
streamDeck.actions.registerAction(new CompleteTasksDialAction());
streamDeck.actions.registerAction(new NextMeetingDialAction());
streamDeck.actions.registerAction(new NotionHabitAction());
streamDeck.actions.registerAction(new HabitDialAction());

// Initialize auto-refresh system
const taskDataSource = createTaskDataSource(refreshNotionData);
autoRefreshManager.registerDataSource(taskDataSource);

// Create a simple habit refresh callback (we'll enhance this later if needed)
const habitDataSource = createHabitDataSource(async () => {
  // Since habits don't have a global refresh system like tasks,
  // we'll just log for now. Individual habit coordinators will
  // handle their own refresh when they detect changes.
  streamDeck.logger.debug("Habit data source refresh triggered");
});
autoRefreshManager.registerDataSource(habitDataSource);

// Configure auto-refresh settings (backend process)
autoRefreshManager.updateSettings({
  enabled: true,
  intervalMinutes: 1, // Check every 1 minute
  detectChangesOnly: true, // Only refresh when changes are detected
});

// Finally, connect to the Stream Deck.
streamDeck.connect();
