import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { NotionTodayAction } from "./actions/notion-today";
import { NotionTodayDialAction } from "./actions/notion-today-dial";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel(LogLevel.TRACE);

// Register the Notion Today action.
streamDeck.actions.registerAction(new NotionTodayAction());
streamDeck.actions.registerAction(new NotionTodayDialAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
