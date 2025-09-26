import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { CompleteTasksDialAction } from "./actions/complete-tasks-dial";
import { NotionTodayAction } from "./actions/notion-today";
import { NextMeetingDialAction } from "./actions/next-meeting-dial";
import { NotionHabitAction } from "./actions/notion-habit";
import { HabitDialAction } from "./actions/habit-dial";

// Set logging level to DEBUG to show useful debugging info while avoiding TRACE level 
// that logs sensitive data like tokens and database IDs in settings objects
streamDeck.logger.setLevel(LogLevel.DEBUG);

// Register the Notion Today action.
streamDeck.actions.registerAction(new NotionTodayAction());
streamDeck.actions.registerAction(new CompleteTasksDialAction());
streamDeck.actions.registerAction(new NextMeetingDialAction());
streamDeck.actions.registerAction(new NotionHabitAction());
streamDeck.actions.registerAction(new HabitDialAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
