import {
  SingletonAction,
  action,
  type DialAction,
  type WillAppearEvent,
} from "@elgato/streamdeck";

import streamDeck from "@elgato/streamdeck";

const LAYOUT_PATH = "layouts/debug-simple.touch-layout.json";

type EmptySettings = Record<string, never>;

const logger = streamDeck.logger.createScope("DebugDialAction");

@action({ UUID: "com.tom-kregenbild.notion-tasks.debug.dial" })
export class DebugDialAction extends SingletonAction<EmptySettings> {
  override async onWillAppear(ev: WillAppearEvent<EmptySettings>): Promise<void> {
    const action = ev.action as unknown as DialAction<EmptySettings>;

    try {
      logger.debug("debug:onWillAppear", { context: action.id });

      await action.setFeedbackLayout(LAYOUT_PATH);
      await action.setFeedback({
        message: { value: "Layout OK" },
      });
      await action.setTitle("Debug Dial");

      logger.debug("debug:layout-applied", { context: action.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("debug:layout-error", {
        context: action.id,
        layout: LAYOUT_PATH,
        message,
      });
    }
  }
}
