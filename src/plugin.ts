import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { CompleteTasksDialAction } from "./actions/complete-tasks-dial";
import { NotionTodayAction } from "./actions/notion-today";
import { NextMeetingDialAction } from "./actions/next-meeting-dial";
import { NotionHabitAction } from "./actions/notion-habit";
import { HabitDialAction } from "./actions/habit-dial";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel(LogLevel.TRACE);

// Register the Notion Today action.
streamDeck.actions.registerAction(new NotionTodayAction());
streamDeck.actions.registerAction(new CompleteTasksDialAction());
streamDeck.actions.registerAction(new NextMeetingDialAction());
streamDeck.actions.registerAction(new NotionHabitAction());
streamDeck.actions.registerAction(new HabitDialAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
