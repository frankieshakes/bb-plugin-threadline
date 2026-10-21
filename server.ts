// bb-plugin-threadline — backend entry.
//
// One job: hand the frontend the current thread's conversation outline (the
// ordered user/assistant messages, each with a short preview). The frontend
// overlay turns the user questions into a navigator rail. The outline `id`
// of a conversation message equals the timeline row's `data-timeline-row-id`
// in the DOM, which is how the overlay scrolls the (virtualized) timeline to a
// question.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUTS_CHANNEL,
  parseShortcut,
  serializeShortcut,
  type ShortcutAction,
} from "./lib/shortcut";

const outlineItemSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  preview: z.string(),
});
export type OutlineItem = z.infer<typeof outlineItemSchema>;

// Effective shortcut per action, in canonical text form; "" = disabled.
const shortcutsSchema = z.object({ previous: z.string(), next: z.string() });
export type Shortcuts = z.infer<typeof shortcutsSchema>;

// Empty (disabled) or a parseable "Ctrl+Alt+ArrowUp"-style shortcut.
const shortcutSchema = z
  .string()
  .refine((value) => value.trim() === "" || parseShortcut(value) !== null, {
    message: 'Use modifiers + a key, e.g. "Ctrl+Alt+ArrowUp".',
  });

// The wire boundary. app.tsx imports only the contract's type.
export const rpcContract = defineRpcContract({
  outline: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ items: z.array(outlineItemSchema) }),
  },
  shortcuts: {
    input: z.object({}),
    output: shortcutsSchema,
  },
  // `value: null` resets the action to its default.
  setShortcut: {
    input: z.object({
      action: z.enum(["previous", "next"]),
      value: shortcutSchema.nullable(),
    }),
    output: shortcutsSchema,
  },
});

// Shortcuts live in plugin storage, not bb.settings: they're edited only by the
// key recorder in the settings section, and a declared string setting would
// also render a free-text field BB offers no way to hide.
const SHORTCUTS_KEY = "shortcuts";
type StoredShortcuts = Partial<Record<ShortcutAction, string>>;

function effectiveShortcuts(stored: StoredShortcuts | undefined): Shortcuts {
  return {
    previous: stored?.previous ?? DEFAULT_SHORTCUTS.previous,
    next: stored?.next ?? DEFAULT_SHORTCUTS.next,
  };
}

/** Collapse whitespace and bound the length so previews stay one clean line. */
function normalizePreview(preview: string): string {
  return preview.replace(/\s+/g, " ").trim().slice(0, 200);
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  // Where the navigator sits along the conversation pane. Read reactively in
  // the frontend via useSettings() — no reload needed when it changes.
  bb.settings.define({
    position: {
      type: "select",
      label: "Rail position",
      description:
        "Vertical position of the rail along the conversation pane.",
      options: ["Top", "Middle", "Bottom"],
      default: "Middle",
    },
    hideBuiltInToc: {
      type: "boolean",
      label: "Hide BB's table of contents",
      description:
        "Hide BB's built-in thread table of contents, so it and Threadline's rail don't overlap. Off shows both.",
      default: true,
    },
    scrollToHover: {
      type: "boolean",
      label: "Sync popover to hover",
      description:
        "When on, hovering a tick scrolls the popover to that prompt's row (lined up with the tick while the rail shows every prompt). Off opens the popover centered on the current prompt.",
      default: true,
    },
  });

  bb.rpc.register(rpcContract, {
    shortcuts: async () =>
      effectiveShortcuts(await bb.storage.kv.get<StoredShortcuts>(SHORTCUTS_KEY)),
    setShortcut: async ({ action, value }) => {
      const stored = { ...(await bb.storage.kv.get<StoredShortcuts>(SHORTCUTS_KEY)) };
      if (value === null) {
        delete stored[action];
      } else {
        const parsed = parseShortcut(value);
        stored[action] = parsed === null ? "" : serializeShortcut(parsed);
      }
      await bb.storage.kv.set(SHORTCUTS_KEY, stored);
      const next = effectiveShortcuts(stored);
      bb.realtime.publish(SHORTCUTS_CHANNEL, next);
      return next;
    },
    outline: async ({ threadId }) => {
      try {
        const result = await bb.sdk.threads.conversationOutline({ threadId });
        const items: OutlineItem[] = result.items.map((item) => ({
          id: item.id,
          role: item.role,
          preview: normalizePreview(item.preview),
        }));
        return { items };
      } catch (cause) {
        // A missing/closed thread or a transient read is not worth surfacing —
        // the overlay simply shows nothing.
        bb.log.warn(`outline read failed for ${threadId}: ${String(cause)}`);
        return { items: [] };
      }
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
