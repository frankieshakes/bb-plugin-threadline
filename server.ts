// bb-plugin-threadline — backend entry.
//
// One job: hand the frontend the current thread's conversation outline (the
// ordered user/assistant messages, each with a short preview). The frontend
// overlay turns the user questions into a navigator widget. The outline `id`
// of a conversation message equals the timeline row's `data-timeline-row-id`
// in the DOM, which is how the overlay scrolls the (virtualized) timeline to a
// question.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const outlineItemSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  preview: z.string(),
});
export type OutlineItem = z.infer<typeof outlineItemSchema>;

// The wire boundary. app.tsx imports only the contract's type.
export const rpcContract = defineRpcContract({
  outline: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ items: z.array(outlineItemSchema) }),
  },
});

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
      label: "Widget position",
      description:
        "Vertical position of the navigator along the conversation pane.",
      options: ["Top", "Middle", "Bottom"],
      default: "Middle",
    },
  });

  bb.rpc.register(rpcContract, {
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
