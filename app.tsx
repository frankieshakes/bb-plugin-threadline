// bb-plugin-threadline — frontend entry.
//
// Renders a navigator widget pinned to the right edge of a thread: one tick per
// user prompt. Hovering the widget opens a popover listing every prompt's
// preview text; clicking a tick (or a popover row) jumps the conversation to
// the start of that prompt and flashes it.
//
// The BB timeline is a *virtualized* list, so an off-screen prompt is not in
// the DOM. Each rendered row carries `data-timeline-row-id="<id>"`, which
// equals the outline item id from the server. To reach an off-screen row we
// estimate a scroll position from the prompt's ordinal, then converge:
// scroll, let the virtualizer realize nearby rows, re-check, and interpolate
// from the realized rows' measured offsets until the target row mounts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import * as HoverCard from "@radix-ui/react-hover-card";
import type { OutlineItem, rpcContract } from "./server";
import { cn } from "@/lib/utils";

const ROW_SELECTOR = "[data-timeline-row-id]";
const SPACER_SELECTOR = "[data-timeline-virtual-spacer]";
const REALIZED_ATTR = "timelineWindowedRealized"; // dataset key -> "true"|"false"

// ---------------------------------------------------------------------------
// Timeline DOM helpers
// ---------------------------------------------------------------------------

function rowSelectorFor(id: string): string {
  const escaped =
    typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(id)
      : id.replace(/["\\]/g, "\\$&");
  return `[data-timeline-row-id="${escaped}"]`;
}

function isRealized(el: HTMLElement): boolean {
  // Non-windowed threads leave the attribute unset (always realized).
  return el.dataset[REALIZED_ATTR] !== "false";
}

/** The nearest scrollable ancestor that actually scrolls the timeline. */
function findScrollElement(): HTMLElement | null {
  const anchor =
    document.querySelector<HTMLElement>(SPACER_SELECTOR) ??
    document.querySelector<HTMLElement>(ROW_SELECTOR);
  let node: HTMLElement | null = anchor?.parentElement ?? null;
  while (node !== null && node !== document.body) {
    const style = getComputedStyle(node);
    const scrolls = /(auto|scroll)/.test(style.overflowY);
    if (scrolls && node.scrollHeight - node.clientHeight > 4) return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * Climb from the composer to the top of the whole bottom-anchored cluster it
 * belongs to. Fixed banners (uncommitted-changes / merge-base, etc.) are
 * stacked *above* the composer inside a shared wrapper that shares the
 * composer's bottom edge, so "bottom" must clamp above them, not just above the
 * composer. We ascend while each ancestor stays flush with the composer's
 * bottom and hasn't grown into the full-height timeline container.
 */
function clusterTop(composer: HTMLElement, paneRect: DOMRect): number {
  const bottom = composer.getBoundingClientRect().bottom;
  let top = composer.getBoundingClientRect().top;
  let node: HTMLElement | null = composer.parentElement;
  while (node !== null && node !== document.body) {
    const rect = node.getBoundingClientRect();
    // Reached a container that spans up to (near) the pane's top — that's the
    // timeline/scroll region behind the composer, not the composer cluster.
    if (rect.top <= paneRect.top + 4) break;
    // Only follow ancestors still anchored to the composer's bottom edge.
    if (Math.abs(rect.bottom - bottom) > 8) break;
    top = Math.min(top, rect.top);
    node = node.parentElement;
  }
  return top;
}

/**
 * Top edge (viewport px) of the chat composer cluster in the same pane as the
 * timeline — including any fixed banners stacked above the composer. The
 * timeline scroll element extends *behind* this cluster, so "bottom" must clamp
 * to its top, not to the scroll element's bottom. Null if none is found.
 */
function findComposerTop(paneRect: DOMRect): number | null {
  const composers = document.querySelectorAll<HTMLElement>(
    "[data-promptbox], [data-app-composer], [data-follow-up-composer]",
  );
  let bottomMost: HTMLElement | null = null;
  let bottomMostBottom = -Infinity;
  for (const el of Array.from(composers)) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Must belong to this pane (mostly horizontally overlapping it).
    const overlap =
      Math.min(rect.right, paneRect.right) - Math.max(rect.left, paneRect.left);
    if (overlap < rect.width * 0.5) continue;
    if (rect.bottom > bottomMostBottom) {
      bottomMost = el;
      bottomMostBottom = rect.bottom;
    }
  }
  return bottomMost === null ? null : clusterTop(bottomMost, paneRect);
}

/** Content-space top of a row (px from the top of the scrolled content). */
function contentTop(el: HTMLElement, scrollEl: HTMLElement): number {
  const rowRect = el.getBoundingClientRect();
  const scrollRect = scrollEl.getBoundingClientRect();
  return rowRect.top - scrollRect.top + scrollEl.scrollTop;
}

function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Brief tint so the eye lands on the jumped-to prompt. Leaves no residue. */
function flash(el: HTMLElement): void {
  if (typeof el.animate !== "function") return;
  el.animate(
    [
      { backgroundColor: "color-mix(in srgb, var(--primary) 16%, transparent)" },
      { backgroundColor: "transparent" },
    ],
    { duration: 1400, easing: "ease-out" },
  );
}

function landOn(el: HTMLElement): void {
  el.scrollIntoView({ block: "center" });
  flash(el);
}

/**
 * Read every realized conversation row and bracket the target ordinal by the
 * nearest realized row above and below it, with their measured content tops.
 */
function bracketRealized(
  scrollEl: HTMLElement,
  ordinalOf: Map<string, number>,
  targetOrdinal: number,
): {
  matched: number;
  below?: { ordinal: number; top: number };
  above?: { ordinal: number; top: number };
  minOrdinal?: number;
  maxOrdinal?: number;
} {
  let matched = 0;
  let below: { ordinal: number; top: number } | undefined;
  let above: { ordinal: number; top: number } | undefined;
  let minOrdinal: number | undefined;
  let maxOrdinal: number | undefined;
  for (const el of Array.from(scrollEl.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const id = el.dataset.timelineRowId;
    if (id === undefined) continue;
    const ordinal = ordinalOf.get(id);
    if (ordinal === undefined || !isRealized(el)) continue;
    matched += 1;
    const top = contentTop(el, scrollEl);
    minOrdinal = minOrdinal === undefined ? ordinal : Math.min(minOrdinal, ordinal);
    maxOrdinal = maxOrdinal === undefined ? ordinal : Math.max(maxOrdinal, ordinal);
    if (ordinal <= targetOrdinal && (below === undefined || ordinal > below.ordinal)) {
      below = { ordinal, top };
    }
    if (ordinal >= targetOrdinal && (above === undefined || ordinal < above.ordinal)) {
      above = { ordinal, top };
    }
  }
  return { matched, below, above, minOrdinal, maxOrdinal };
}

/**
 * Scroll the timeline to a message and flash it. `ordinalOf` maps every outline
 * id to its position in the full outline (used to steer the virtualizer).
 */
async function navigateToRow(
  id: string,
  ordinalOf: Map<string, number>,
  total: number,
): Promise<void> {
  const selector = rowSelectorFor(id);

  const direct = document.querySelector<HTMLElement>(selector);
  if (direct !== null && isRealized(direct)) {
    landOn(direct);
    return;
  }

  const scrollEl = findScrollElement();
  if (scrollEl === null) {
    // Non-windowed / unexpected layout: best effort if it happens to exist.
    const fallback = document.querySelector<HTMLElement>(selector);
    if (fallback !== null) landOn(fallback);
    return;
  }

  const targetOrdinal = ordinalOf.get(id) ?? 0;
  const maxTop = () => Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  const clampTop = (value: number) => Math.max(0, Math.min(maxTop(), value));

  // First estimate from the ordinal fraction of the whole conversation.
  const fraction = total > 1 ? targetOrdinal / (total - 1) : 0;
  scrollEl.scrollTop = clampTop(fraction * maxTop());

  let sawAnyMatch = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await raf();
    await raf();

    const found = document.querySelector<HTMLElement>(selector);
    if (found !== null && isRealized(found)) {
      landOn(found);
      return;
    }

    const info = bracketRealized(scrollEl, ordinalOf, targetOrdinal);
    if (info.matched > 0) sawAnyMatch = true;

    if (info.below !== undefined && info.above !== undefined) {
      // Interpolate the target's content top between the bracketing rows.
      const span = info.above.ordinal - info.below.ordinal;
      const estTop =
        span <= 0
          ? info.below.top
          : info.below.top +
            ((targetOrdinal - info.below.ordinal) / span) *
              (info.above.top - info.below.top);
      scrollEl.scrollTop = clampTop(estTop - scrollEl.clientHeight / 2);
    } else if (info.minOrdinal !== undefined && targetOrdinal < info.minOrdinal) {
      scrollEl.scrollTop = clampTop(scrollEl.scrollTop - scrollEl.clientHeight * 0.85);
    } else if (info.maxOrdinal !== undefined && targetOrdinal > info.maxOrdinal) {
      scrollEl.scrollTop = clampTop(scrollEl.scrollTop + scrollEl.clientHeight * 0.85);
    } else if (!sawAnyMatch) {
      // Outline ids never matched any DOM row after several tries — the id
      // space differs from what we assumed. Give up on precision.
      if (attempt >= 4) break;
      scrollEl.scrollTop = clampTop(fraction * maxTop());
    }
  }

  const last = document.querySelector<HTMLElement>(selector);
  if (last !== null) landOn(last);
}

/** The user row currently nearest the top of the viewport, for highlighting. */
function computeActiveId(userIds: readonly string[]): string | null {
  const scrollEl = findScrollElement();
  if (scrollEl === null) return null;
  const scrollRect = scrollEl.getBoundingClientRect();
  const marker = scrollRect.top + scrollRect.height * 0.28;
  let active: string | null = null;
  let bestTop = -Infinity;
  const wanted = new Set(userIds);
  for (const el of Array.from(scrollEl.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const id = el.dataset.timelineRowId;
    if (id === undefined || !wanted.has(id) || !isRealized(el)) continue;
    const top = el.getBoundingClientRect().top;
    if (top <= marker && top > bestTop) {
      bestTop = top;
      active = id;
    }
  }
  return active;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface Outline {
  /** Full outline (user + assistant), in order — used to steer scrolling. */
  ordinalOf: Map<string, number>;
  total: number;
  /** Just the user prompts, in order — the navigator's ticks. */
  prompts: OutlineItem[];
}

const EMPTY_OUTLINE: Outline = {
  ordinalOf: new Map(),
  total: 0,
  prompts: [],
};

// BB injects synthetic messages into a thread as role "user" (e.g. cross-thread
// completion pings), each prefixed with this marker.
const BB_SYSTEM_PREFIX = "[bb system]";

// They're real timeline rows — kept in ordinalOf/total so scroll math stays
// accurate — but they aren't the human's prompts, so they don't belong on the
// navigator's ticks or popover.
function isUserPrompt(item: OutlineItem): boolean {
  return item.role === "user" && !item.preview.startsWith(BB_SYSTEM_PREFIX);
}

function useOutline(threadId: string | null): Outline {
  const rpc = useRpc<typeof rpcContract>();
  const [outline, setOutline] = useState<Outline>(EMPTY_OUTLINE);

  const refetch = useCallback(() => {
    if (threadId === null) {
      setOutline(EMPTY_OUTLINE);
      return;
    }
    rpc.call("outline", { threadId }).then((result) => {
      const ordinalOf = new Map<string, number>();
      result.items.forEach((item, index) => ordinalOf.set(item.id, index));
      setOutline({
        ordinalOf,
        total: result.items.length,
        prompts: result.items.filter(isUserPrompt),
      });
    }, () => undefined);
  }, [rpc, threadId]);

  useEffect(() => {
    setOutline(EMPTY_OUTLINE);
    if (threadId === null) return;
    refetch();
    // The timeline streams; poll so newly asked prompts appear. Cheap
    // loopback read. Also refetch when the window regains focus.
    const interval = window.setInterval(refetch, 4000);
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [threadId, refetch]);

  return outline;
}

type Position = "top" | "middle" | "bottom";

interface PaneAnchor {
  right: number;
  top: number;
  transform: string;
}

/**
 * Anchor the widget to the conversation pane (the timeline scroll element), not
 * the app window: pinned to its right edge, at the top / middle / bottom of its
 * vertical extent per the `position` setting. Recomputes as the pane resizes —
 * e.g. when the right side panel opens or closes.
 */
function usePaneAnchor(position: Position, revision: string): PaneAnchor | null {
  const [anchor, setAnchor] = useState<PaneAnchor | null>(null);

  useEffect(() => {
    const margin = 10;
    let frame = 0;
    const recompute = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = findScrollElement();
        if (el === null) {
          setAnchor(null);
          return;
        }
        const rect = el.getBoundingClientRect();
        const right = Math.max(0, window.innerWidth - rect.right);
        if (position === "top") {
          setAnchor({ right, top: rect.top + margin, transform: "translateY(0)" });
        } else if (position === "bottom") {
          const composerTop = findComposerTop(rect);
          const lower =
            composerTop === null ? rect.bottom : Math.min(rect.bottom, composerTop);
          setAnchor({ right, top: lower - margin, transform: "translateY(-100%)" });
        } else {
          setAnchor({
            right,
            top: rect.top + rect.height / 2,
            transform: "translateY(-50%)",
          });
        }
      });
    };

    recompute();
    const el = findScrollElement();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(recompute);
      if (el !== null) observer.observe(el);
      observer.observe(document.body);
      // The composer floats over the timeline, so its expand/collapse does not
      // resize the scroll element — observe it directly so "bottom" re-anchors.
      // Also observe its wrapper: a banner toggling above the composer changes
      // the wrapper's height (and the composer's position) without resizing the
      // composer itself, so watching only the composer would miss it.
      for (const composer of Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-promptbox], [data-app-composer], [data-follow-up-composer]",
        ),
      )) {
        observer.observe(composer);
        if (composer.parentElement !== null) observer.observe(composer.parentElement);
      }
    }
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", recompute);
    };
  }, [position, revision]);

  return anchor;
}

function readPosition(value: unknown): Position {
  const normalized = String(value ?? "").toLowerCase();
  return normalized === "top" || normalized === "bottom" ? normalized : "middle";
}

/** Track which prompt is currently in view; recomputed on timeline scroll. */
function useActivePrompt(prompts: OutlineItem[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const idsKey = prompts.map((prompt) => prompt.id).join(",");

  useEffect(() => {
    const ids = idsKey === "" ? [] : idsKey.split(",");
    if (ids.length === 0) {
      setActiveId(null);
      return;
    }
    let frame = 0;
    const recompute = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setActiveId(computeActiveId(ids)));
    };
    recompute();
    const scrollEl = findScrollElement();
    scrollEl?.addEventListener("scroll", recompute, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(frame);
      scrollEl?.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [idsKey]);

  return activeId;
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

/** Vary tick length by preview length for the document-minimap look. */
function tickWidth(preview: string): number {
  return 8 + Math.round((Math.min(preview.length, 72) / 72) * 9);
}

// The popover scrolls at whichever comes first: this many prompt rows, 70vh, or
// the space Radix actually has on screen. Beyond the row cap the next row peeks
// under the fold as a scroll affordance.
const MAX_VISIBLE_PROMPTS = 9;
const PROMPT_ROW_PX = 32; // one truncated row: px-2 py-1.5, text-sm
const POPOVER_CHROME_PX = 40; // sticky header (bordered) + list padding
const POPOVER_MAX_HEIGHT = `min(${POPOVER_CHROME_PX + MAX_VISIBLE_PROMPTS * PROMPT_ROW_PX}px, 70vh, var(--radix-hover-card-content-available-height))`;

function Navigator() {
  const { threadId } = useBbContext();
  const { values } = useSettings();
  const position = readPosition(values?.position);
  const { ordinalOf, total, prompts } = useOutline(threadId);
  const scrollActiveId = useActivePrompt(prompts);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // The pinned click wins over scroll-based detection until the user scrolls.
  const activeId = pinnedId ?? scrollActiveId;
  const anchor = usePaneAnchor(position, `${threadId ?? ""}:${prompts.length}`);
  const jumpingRef = useRef(false);

  const go = useCallback(
    (id: string) => {
      if (jumpingRef.current) return;
      jumpingRef.current = true;
      // Navigation centers the row, but scroll-based detection uses a near-top
      // line and would resolve to the previous prompt — so mark the clicked
      // prompt active optimistically until the next manual scroll.
      setPinnedId(id);
      navigateToRow(id, ordinalOf, total).finally(() => {
        jumpingRef.current = false;
      });
    },
    [ordinalOf, total],
  );

  // A pin from another thread must not suppress detection here.
  useEffect(() => setPinnedId(null), [threadId]);

  // Release the optimistic pin once the user scrolls or navigates by hand.
  useEffect(() => {
    if (pinnedId === null) return;
    const release = () => setPinnedId(null);
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchmove", release, { passive: true });
    window.addEventListener("keydown", release);
    return () => {
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchmove", release);
      window.removeEventListener("keydown", release);
    };
  }, [pinnedId]);

  const activeIndex = useMemo(
    () => prompts.findIndex((prompt) => prompt.id === activeId),
    [prompts, activeId],
  );

  if (threadId === null || prompts.length === 0) return null;

  return (
    <HoverCard.Root openDelay={90} closeDelay={140}>
      <HoverCard.Trigger asChild>
        <div
          role="navigation"
          aria-label="Jump to a prompt in this conversation"
          className="fixed z-40 flex flex-col items-end gap-[5px] rounded-lg border border-border/50 bg-card/60 px-1 py-2.5 opacity-80 shadow-sm backdrop-blur-sm transition-[opacity,background-color,border-color] duration-150 hover:border-border hover:bg-card hover:opacity-100"
          style={{
            right: anchor === null ? 6 : anchor.right + 6,
            top: anchor === null ? "50%" : anchor.top,
            transform: anchor === null ? "translateY(-50%)" : anchor.transform,
          }}
        >
          {prompts.map((prompt, index) => {
            const isActive = index === activeIndex;
            return (
              <button
                key={prompt.id}
                type="button"
                title={prompt.preview}
                aria-label={`Prompt ${index + 1}: ${prompt.preview}`}
                onClick={() => go(prompt.id)}
                className={cn(
                  "h-[3px] rounded-full transition-all",
                  isActive
                    ? "bg-foreground"
                    : "bg-muted-foreground/40 hover:bg-muted-foreground",
                )}
                style={{ width: isActive ? 18 : tickWidth(prompt.preview) }}
              />
            );
          })}
        </div>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          side="left"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          style={{ maxHeight: POPOVER_MAX_HEIGHT, width: "22rem" }}
          className="z-50 flex flex-col overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
        >
          <div className="sticky top-0 z-10 border-b border-border bg-popover px-3 py-2 text-xs font-medium text-muted-foreground">
            Your prompts
          </div>
          <div className="p-1">
            {prompts.map((prompt, index) => {
            const isActive = index === activeIndex;
            return (
              <button
                key={prompt.id}
                type="button"
                onClick={() => go(prompt.id)}
                className={cn(
                  // Selected uses the stronger token (bg-muted); hover uses the
                  // lighter bg-accent so the two states stay visually distinct.
                  "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                  isActive
                    ? "bg-muted text-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <span className="mt-px w-5 shrink-0 text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {prompt.preview || "(no text)"}
                </span>
              </button>
            );
            })}
          </div>
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

// An app-wide overlay: mounted once per window, outside route layout, so it can
// read the active thread via useBbContext() and float over any surface.
export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "threadline-navigator",
    component: Navigator,
  });
});
