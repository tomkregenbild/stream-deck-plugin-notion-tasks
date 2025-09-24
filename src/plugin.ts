import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { ActiveTasksDialAction } from "./actions/active-tasks-dial";
import { NotionTodayAction } from "./actions/notion-today";
import { NextMeetingDialAction } from "./actions/next-meeting-dial";
import { NotionHabitAction } from "./actions/notion-habit";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel(LogLevel.TRACE);

// Register the Notion Today action.
streamDeck.actions.registerAction(new NotionTodayAction());
streamDeck.actions.registerAction(new ActiveTasksDialAction());
streamDeck.actions.registerAction(new NextMeetingDialAction());
streamDeck.actions.registerAction(new NotionHabitAction());
streamDeck.actions.registerAction(new NotionHabitAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
