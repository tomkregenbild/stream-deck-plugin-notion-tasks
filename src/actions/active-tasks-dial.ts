import {
  SingletonAction,
  action,
  type DialAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import streamDeck from "@elgato/streamdeck";

import { type TaskSummary } from "../notion/task-helpers";
import {
  getNotionTodaySummary,
  subscribeToNotionSummary,
  type NotionSettings,
} from "./notion-today";

const LAYOUT_PATH = "layouts/active-summary.touch-layout.json";

interface ContextState {
  id: string;
  action: DialAction<NotionSettings>;
  layoutApplied: boolean;
  unsubscribe?: () => void;
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
    };
    this.contexts.set(state.id, state);

    logger.debug("onWillAppear", { context: state.id });

    await this.ensureLayout(state);
    await action.setTitle("Active Tasks");
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
}

function clampRatio(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
