// bb-plugin-threadline — frontend entry.
//
// Renders a navigator rail pinned to the right edge of a thread: one tick per
// user prompt. Hovering the rail opens a popover listing every prompt's
// preview text; clicking a tick (or a popover row) jumps the conversation to
// the start of that prompt and flashes it.
//
// The BB timeline is a *virtualized* list, so an off-screen prompt is not in
// the DOM. Each rendered row carries `data-timeline-row-id="<id>"`, which
// equals the outline item id from the server. To reach an off-screen row we
// estimate a scroll position from the prompt's ordinal, then converge:
// scroll, let the virtualizer realize nearby rows, re-check, and interpolate
// from the realized rows' measured offsets until the target row mounts.
import {
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  definePluginApp,
  useBbContext,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import * as HoverCard from "@radix-ui/react-hover-card";
import type { OutlineItem, Shortcuts, rpcContract } from "./server";
import {
  SHORTCUTS_CHANNEL,
  type ShortcutAction,
  formatShortcut,
  matchesShortcut,
  parseShortcut,
  recordShortcut,
  serializeShortcut,
} from "@/lib/shortcut";
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

// An ancestor counts as part of the composer's bottom-anchored cluster only if
// its bottom edge is flush with the composer's. The cluster wrappers are
// pixel-flush in CSS (`space-y-2` spaces *between* children, never below the
// last), so this only absorbs sub-pixel getBoundingClientRect rounding — keep
// it tight: a looser value would let a genuinely taller container with its own
// bottom spacing pass as "flush" and pull the clamp too low.
const CLUSTER_FLUSH_PX = 1.5;
// Stop the climb once an ancestor reaches (near) the pane's top: that's the
// full-height timeline/scroll region behind the composer, not the cluster.
const CLUSTER_PANE_TOP_PX = 4;

/**
 * Climb from the composer to the top of the whole bottom-anchored cluster it
 * belongs to. Fixed banners (uncommitted-changes / merge-base, etc.) are
 * stacked *above* the composer inside a shared wrapper that shares the
 * composer's bottom edge, so "bottom" must clamp above them, not just above the
 * composer. We ascend while each ancestor stays flush with the composer's
 * bottom and hasn't grown into the full-height timeline container.
 */
function clusterTop(composer: HTMLElement, paneRect: DOMRect): number {
  const rect0 = composer.getBoundingClientRect();
  const bottom = rect0.bottom;
  let top = rect0.top;
  let node: HTMLElement | null = composer.parentElement;
  while (node !== null && node !== document.body) {
    const rect = node.getBoundingClientRect();
    if (rect.top <= paneRect.top + CLUSTER_PANE_TOP_PX) break;
    if (Math.abs(rect.bottom - bottom) > CLUSTER_FLUSH_PX) break;
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

/**
 * BB's timeline sticks to the bottom, and only counts a scroll as the user's
 * inside a short window opened by real wheel / touch / key input on it. A bare
 * programmatic scroll leaves it stuck, so the next content resize (a page
 * loading, a row being measured) snaps the view back to the bottom. A
 * synthetic upward wheel on the scroller opens that window first. It doesn't
 * bubble, so our own window-level wheel listeners (pin release, jump abort)
 * never see it.
 */
function claimScroll(scrollEl: HTMLElement): void {
  scrollEl.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: false }));
}

/** Programmatic timeline scroll that BB won't snap back to the bottom. */
function scrollTimelineTo(scrollEl: HTMLElement, top: number): void {
  claimScroll(scrollEl);
  scrollEl.scrollTop = top;
}

function landOn(el: HTMLElement, withFlash = true): void {
  const scrollEl = findScrollElement();
  if (scrollEl !== null) claimScroll(scrollEl);
  el.scrollIntoView({ block: "center" });
  if (withFlash) flash(el);
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
  /** Oldest / newest rendered rows, to extrapolate past the rendered window. */
  first?: { ordinal: number; top: number };
  last?: { ordinal: number; top: number };
} {
  let matched = 0;
  let below: { ordinal: number; top: number } | undefined;
  let above: { ordinal: number; top: number } | undefined;
  let minOrdinal: number | undefined;
  let maxOrdinal: number | undefined;
  let first: { ordinal: number; top: number } | undefined;
  let last: { ordinal: number; top: number } | undefined;
  for (const el of Array.from(scrollEl.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const id = el.dataset.timelineRowId;
    if (id === undefined) continue;
    const ordinal = ordinalOf.get(id);
    if (ordinal === undefined || !isRealized(el)) continue;
    matched += 1;
    const top = contentTop(el, scrollEl);
    if (first === undefined || ordinal < first.ordinal) first = { ordinal, top };
    if (last === undefined || ordinal > last.ordinal) last = { ordinal, top };
    minOrdinal = minOrdinal === undefined ? ordinal : Math.min(minOrdinal, ordinal);
    maxOrdinal = maxOrdinal === undefined ? ordinal : Math.max(maxOrdinal, ordinal);
    if (ordinal <= targetOrdinal && (below === undefined || ordinal > below.ordinal)) {
      below = { ordinal, top };
    }
    if (ordinal >= targetOrdinal && (above === undefined || ordinal < above.ordinal)) {
      above = { ordinal, top };
    }
  }
  return { matched, below, above, minOrdinal, maxOrdinal, first, last };
}

// BB pages a long thread's timeline: only the newest events are loaded, and
// an older page loads when a sentinel above the first row nears the viewport
// (BB then restores the scroll anchor, pushing the view back down). The list is
// also virtualized — only rows near the viewport exist in the DOM at all — so
// neither "is the row in the DOM" nor a row count says what's loaded. Instead:
// parked at the top, the oldest *rendered* prompt is the oldest loaded one, and
// a page has arrived when the content grows.
const OLDER_PAGE_TIMEOUT_MS = 5000;
const MAX_OLDER_PAGES = 200;
// BB's loader is an IntersectionObserver with a 600px top margin, so it fires
// only when the sentinel *enters* range — parking at the top after a page
// lands (before BB's anchor restore moves the view) never re-fires it. Every
// BOUNCE_FRAMES while waiting, step this far down and back up to re-trigger.
const BOUNCE_FRAMES = 24;
const BOUNCE_PX = 2400;
// A page that's still loading past OLDER_PAGE_TIMEOUT_MS shows BB's "Loading
// older messages…" status; keep waiting this much longer for it.
const SLOW_PAGE_TIMEOUT_MS = 25000;
const LOADING_OLDER_PATTERN = /loading older messages/i;
const SEEK_ATTEMPTS = 40;
// After landing, an older page that was already loading can still finish and
// BB's anchor restore then drags the view off the target. Hold it for this long.
const SETTLE_MS = 1200;

/** Run `tick` every frame until `done()` holds; false on timeout or abort. */
async function waitUntil(
  done: () => boolean,
  timeoutMs: number,
  signal: AbortSignal,
  tick?: () => void,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!signal.aborted && performance.now() < deadline) {
    if (done()) return true;
    tick?.();
    await raf();
  }
  return !signal.aborted && done();
}

/**
 * When auto-load is off (BB disables it after a failed load), BB shows a
 * "Load older messages" button at the top of the timeline instead.
 */
function clickLoadOlderButton(scrollEl: HTMLElement): void {
  Array.from(scrollEl.querySelectorAll<HTMLButtonElement>("button"))
    .find(
      (candidate) =>
        !candidate.disabled && /load older messages/i.test(candidate.textContent ?? ""),
    )
    ?.click();
}

function isLoadingOlder(scrollEl: HTMLElement): boolean {
  return Array.from(scrollEl.querySelectorAll('[role="status"]')).some((el) =>
    LOADING_OLDER_PATTERN.test(el.textContent ?? ""),
  );
}

/**
 * Page older events in until the target prompt is loaded: park at the top,
 * and while the oldest rendered prompt is still newer than the target, wait
 * for the next page to grow the content. False only on abort; if pages stop
 * coming (nothing older), the caller seeks within what's loaded.
 */
async function loadThrough(
  targetOrdinal: number,
  scrollEl: HTMLElement,
  ordinalOf: Map<string, number>,
  signal: AbortSignal,
): Promise<boolean> {
  // One timeout is allowed to be a hiccup, not the end of history.
  let retried = false;
  for (let page = 0; page < MAX_OLDER_PAGES; page += 1) {
    scrollTimelineTo(scrollEl, 0);
    await raf();
    await raf();
    if (signal.aborted) return false;
    // A late anchor restore from the previous page can override the jump.
    if (scrollEl.scrollTop > 1) continue;
    const oldest = bracketRealized(scrollEl, ordinalOf, targetOrdinal).minOrdinal;
    if (oldest !== undefined && oldest <= targetOrdinal) return true;
    const height = scrollEl.scrollHeight;
    const arrived = () => scrollEl.scrollHeight > height + 1;
    let ticks = 0;
    let grew = await waitUntil(
      arrived,
      OLDER_PAGE_TIMEOUT_MS,
      signal,
      () => {
        ticks += 1;
        const phase = ticks % BOUNCE_FRAMES;
        if (phase === 0) {
          scrollTimelineTo(scrollEl, BOUNCE_PX + scrollEl.clientHeight);
        } else if (phase === 4) {
          scrollTimelineTo(scrollEl, 0);
          // When auto-load is off, press BB's manual loader instead.
          clickLoadOlderButton(scrollEl);
        }
      },
    );
    // Slow, not finished: BB is still showing its loading status.
    if (!grew && !signal.aborted && isLoadingOlder(scrollEl)) {
      grew = await waitUntil(arrived, SLOW_PAGE_TIMEOUT_MS, signal);
    }
    if (signal.aborted) return false;
    if (!grew) {
      if (retried) return true; // nothing older to load
      retried = true;
    }
  }
  return true;
}

/**
 * Scroll the timeline to a message and flash it; true once it lands.
 * `ordinalOf` maps every outline id to its position in the full outline (used
 * to steer the virtualizer). Aborting `signal` (the user took over, a newer
 * jump, a thread switch) stops steering.
 */
async function navigateToRow(
  id: string,
  ordinalOf: Map<string, number>,
  signal: AbortSignal,
): Promise<boolean> {
  const selector = rowSelectorFor(id);
  const landIfRendered = (): boolean => {
    const el = document.querySelector<HTMLElement>(selector);
    if (el === null || !isRealized(el)) return false;
    landOn(el);
    return true;
  };
  const scrollEl = findScrollElement();
  if (scrollEl === null) {
    // Non-windowed / unexpected layout: best effort if it happens to exist.
    return landIfRendered();
  }

  const targetOrdinal = ordinalOf.get(id) ?? 0;
  const maxTop = () => Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
  const clampTop = (value: number) => Math.max(0, Math.min(maxTop(), value));

  // Hold the landed row in view while late page loads settle — only needed if
  // we paged in history or BB is still loading some.
  let pagedIn = false;
  const settle = async (): Promise<boolean> => {
    if (!pagedIn && !isLoadingOlder(scrollEl)) return true;
    await waitUntil(() => false, SETTLE_MS, signal, () => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el === null || !isRealized(el)) return;
      const view = scrollEl.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      if (rect.bottom < view.top || rect.top > view.bottom) landOn(el, false);
    });
    return !signal.aborted;
  };

  // Seek: interpolate between rendered rows that bracket the target, else
  // extrapolate from the rendered rows' spacing — secant steps that converge
  // in a few frames even across tens of thousands of px. Only when that runs
  // into the top with the target still older than everything rendered do we
  // page in history: parking at the top kicks off a load, and one that
  // finishes after landing drags the view away.
  for (let attempt = 0; attempt < SEEK_ATTEMPTS; attempt += 1) {
    if (signal.aborted) return false;
    if (landIfRendered()) return settle();
    const info = bracketRealized(scrollEl, ordinalOf, targetOrdinal);
    const olderThanRendered = info.minOrdinal === undefined || targetOrdinal < info.minOrdinal;
    if (olderThanRendered && scrollEl.scrollTop <= 1) {
      pagedIn = true;
      if (!(await loadThrough(targetOrdinal, scrollEl, ordinalOf, signal))) return false;
      continue;
    }
    let estTop: number | null = null;
    if (info.below !== undefined && info.above !== undefined) {
      const span = info.above.ordinal - info.below.ordinal;
      estTop =
        span <= 0
          ? info.below.top
          : info.below.top +
            ((targetOrdinal - info.below.ordinal) / span) * (info.above.top - info.below.top);
    } else if (
      info.first !== undefined &&
      info.last !== undefined &&
      info.last.ordinal > info.first.ordinal
    ) {
      const pxPerOrdinal =
        (info.last.top - info.first.top) / (info.last.ordinal - info.first.ordinal);
      const from = targetOrdinal < info.first.ordinal ? info.first : info.last;
      estTop = from.top + (targetOrdinal - from.ordinal) * pxPerOrdinal;
    }
    const step = olderThanRendered ? -0.85 : 0.85;
    scrollTimelineTo(
      scrollEl,
      estTop !== null
        ? clampTop(estTop - scrollEl.clientHeight / 2)
        : clampTop(scrollEl.scrollTop + step * scrollEl.clientHeight),
    );
    await raf();
    await raf();
  }
  return !signal.aborted && landIfRendered() && settle();
}

// Within this many px of the end, the timeline counts as scrolled to the bottom.
const AT_BOTTOM_PX = 32;

/**
 * The user row currently nearest the top of the viewport, for highlighting.
 * Scrolled to the bottom, the newest visible prompt wins instead: a just-sent
 * prompt sits low in the viewport, below the near-top line, and would
 * otherwise leave the previous prompt highlighted until its reply grows.
 */
function computeActiveId(userIds: readonly string[]): string | null {
  const scrollEl = findScrollElement();
  if (scrollEl === null) return null;
  const scrollRect = scrollEl.getBoundingClientRect();
  const nearTopLine = scrollRect.top + scrollRect.height * 0.28;
  const atBottom =
    scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= AT_BOTTOM_PX;
  // The composer floats over the timeline's bottom edge.
  const visibleBottom = findComposerTop(scrollRect) ?? scrollRect.bottom;
  const line = atBottom ? visibleBottom : nearTopLine;
  let active: string | null = null;
  let bestTop = -Infinity;
  const wanted = new Set(userIds);
  for (const el of Array.from(scrollEl.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
    const id = el.dataset.timelineRowId;
    if (id === undefined || !wanted.has(id) || !isRealized(el)) continue;
    const top = el.getBoundingClientRect().top;
    if (top <= line && top > bestTop) {
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
  /** Just the user prompts, in order — the navigator's ticks. */
  prompts: OutlineItem[];
}

const EMPTY_OUTLINE: Outline = {
  ordinalOf: new Map(),
  prompts: [],
};

// BB injects synthetic messages into a thread as role "user" (e.g. cross-thread
// completion pings), each prefixed with this marker.
const BB_SYSTEM_PREFIX = "[bb system]";

// They're real timeline rows — kept in ordinalOf so scroll math stays
// accurate — but they aren't the human's prompts, so they don't belong on the
// navigator's ticks or popover.
function isUserPrompt(item: OutlineItem): boolean {
  return item.role === "user" && !item.preview.startsWith(BB_SYSTEM_PREFIX);
}

function useOutline(threadId: string | null): Outline {
  const rpc = useRpc<typeof rpcContract>();
  const [outline, setOutline] = useState<Outline>(EMPTY_OUTLINE);

  useEffect(() => {
    setOutline(EMPTY_OUTLINE);
    if (threadId === null) return;
    // Responses can land out of order: a slow read for the previous thread, or
    // overlapping polls on a big one. Apply only while this thread is current,
    // and never an older request's over a newer one's.
    let cancelled = false;
    let issued = 0;
    let applied = 0;
    let appliedKey = "";
    const refetch = () => {
      const request = ++issued;
      rpc.call("outline", { threadId }).then((result) => {
        if (cancelled || request < applied) return;
        applied = request;
        // Polls mostly return the same outline; keep its identity so memoized
        // callbacks and listeners don't churn every few seconds.
        const key = result.items.map((item) => `${item.id}\u0000${item.preview}`).join("\u0001");
        if (key === appliedKey) return;
        appliedKey = key;
        const ordinalOf = new Map<string, number>();
        result.items.forEach((item, index) => ordinalOf.set(item.id, index));
        setOutline({ ordinalOf, prompts: result.items.filter(isUserPrompt) });
      }, () => undefined);
    };
    refetch();
    // The timeline streams; poll so newly asked prompts appear. Cheap
    // loopback read. Also refetch when the window regains focus.
    const interval = window.setInterval(refetch, 4000);
    const onFocus = () => refetch();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [rpc, threadId]);

  return outline;
}

type Position = "top" | "middle" | "bottom";

interface PaneAnchor {
  right: number;
  top: number;
  transform: string;
  /** Visible pane height (px) above the composer cluster — sizes the rail. */
  height: number;
}

/**
 * Anchor the rail to the conversation pane (the timeline scroll element), not
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
        const composerTop = findComposerTop(rect);
        const lower =
          composerTop === null ? rect.bottom : Math.min(rect.bottom, composerTop);
        const height = Math.max(0, lower - rect.top);
        if (position === "top") {
          setAnchor({ right, top: rect.top + margin, transform: "translateY(0)", height });
        } else if (position === "bottom") {
          setAnchor({ right, top: lower - margin, transform: "translateY(-100%)", height });
        } else {
          setAnchor({
            right,
            top: rect.top + rect.height / 2,
            transform: "translateY(-50%)",
            height,
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

// BB's own prompt navigator (the "Thread table of contents"). There is no
// setting or plugin API to turn it off, so Threadline hides it with a
// stylesheet it removes on unmount — disabling the setting or the plugin
// restores it. Keyed on BB's DOM, so a BB update could rename it.
const BUILT_IN_TOC_SELECTOR = "[data-thread-toc]";

/** While `hidden`, hide BB's built-in table of contents. */
function useHideBuiltInToc(hidden: boolean): void {
  useEffect(() => {
    if (!hidden) return;
    const style = document.createElement("style");
    style.dataset.threadline = "hide-built-in-toc";
    style.textContent = `${BUILT_IN_TOC_SELECTOR} { display: none !important; }`;
    document.head.append(style);
    return () => style.remove();
  }, [hidden]);
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isShortcuts(value: unknown): value is Shortcuts {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.previous === "string" && typeof record.next === "string";
}

const SHORTCUT_FETCH_ATTEMPTS = 3;
const SHORTCUT_RETRY_MS = 3000;

/**
 * The user's shortcuts (canonical text; "" = disabled), null until loaded.
 * Kept live across windows by the server's realtime broadcast, and refetched
 * after a reconnect in case a broadcast was missed.
 */
function useShortcuts(): {
  shortcuts: Shortcuts | null;
  save: (action: ShortcutAction, value: string | null) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [shortcuts, setShortcuts] = useState<Shortcuts | null>(null);
  const connection = useRealtimeConnectionState();
  // Bumped by every broadcast or save, so a fetch that was already in flight
  // can't overwrite the newer value when it lands.
  const versionRef = useRef(0);

  // Fetch on mount and on every connection change (a reconnect may have missed
  // a broadcast). Not gated on "connected": RPC doesn't need the realtime
  // socket, and a socket stuck connecting must not leave shortcuts dead.
  useEffect(() => {
    let cancelled = false;
    let retry = 0;
    const load = (attempt: number) => {
      const version = versionRef.current;
      rpc.call("shortcuts", {}).then(
        (next) => {
          if (!cancelled && versionRef.current === version) setShortcuts(next);
        },
        () => {
          if (!cancelled && attempt < SHORTCUT_FETCH_ATTEMPTS) {
            retry = window.setTimeout(() => load(attempt + 1), SHORTCUT_RETRY_MS);
          }
        },
      );
    };
    load(1);
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
    };
  }, [rpc, connection]);

  useRealtime(SHORTCUTS_CHANNEL, (payload) => {
    if (!isShortcuts(payload)) return;
    versionRef.current += 1;
    setShortcuts(payload);
  });

  const save = useCallback(
    async (action: ShortcutAction, value: string | null) => {
      const next = await rpc.call("setShortcut", { action, value });
      versionRef.current += 1;
      setShortcuts(next);
    },
    [rpc],
  );

  return { shortcuts, save };
}

// True while a recorder in the settings section is listening, so pressing the
// current shortcut to rebind it doesn't also jump the thread.
let recordingShortcut = false;

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
    // Listen in the capture phase on the document rather than on the scroll
    // element found now: BB may swap the timeline's scroller (or a short thread
    // may not scroll yet), and a listener on a stale element goes silent.
    // Scroll events don't bubble, but they do pass through capture.
    const options = { capture: true, passive: true } as const;
    document.addEventListener("scroll", recompute, options);
    window.addEventListener("resize", recompute);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("scroll", recompute, options);
      window.removeEventListener("resize", recompute);
    };
  }, [idsKey]);

  return activeId;
}

// ---------------------------------------------------------------------------
// Rail layout
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Vary tick length by preview length for the document-minimap look. */
function tickWidth(preview: string): number {
  return 8 + Math.round((Math.min(preview.length, 72) / 72) * 9);
}

// The rail may grow to this share of the pane's visible height (above the
// composer). Each prompt gets a full-width hit row `pitch` px tall with its tick
// centered in it. Short threads keep the roomy natural pitch; longer ones
// compress toward the minimum; past that, the rail shows a window of prompts
// that follows the active one, with "+N" counts for what's hidden.
const RAIL_MAX_FRACTION = 0.5;
const RAIL_PAD_Y_PX = 10; // py-2.5, each side
const NATURAL_PITCH_PX = 8;
const MIN_PITCH_PX = 5;
const EDGE_LABEL_PX = 14; // "+N" row above / below a windowed rail
const EDGE_FADE_PX = 14;
// A windowed rail scrolls only once the active tick comes within this many
// rows of an edge, so clicking a tick doesn't slide the rail under the cursor.
const WINDOW_MARGIN = 3;
const WHEEL_STEP_PX = 16; // wheel delta per one-tick shift of a windowed rail

interface RailLayout {
  pitch: number;
  tickHeight: number;
  /** Ticks shown at once; the full prompt count unless windowed. */
  capacity: number;
  windowed: boolean;
}

function railLayout(count: number, paneHeight: number): RailLayout {
  const inner = Math.max(0, paneHeight * RAIL_MAX_FRACTION - 2 * RAIL_PAD_Y_PX);
  if (count * NATURAL_PITCH_PX <= inner) {
    return { pitch: NATURAL_PITCH_PX, tickHeight: 3, capacity: count, windowed: false };
  }
  if (count * MIN_PITCH_PX <= inner) {
    const pitch = Math.floor(inner / count);
    return { pitch, tickHeight: pitch >= 6 ? 3 : 2, capacity: count, windowed: false };
  }
  const capacity = Math.max(1, Math.floor((inner - 2 * EDGE_LABEL_PX) / MIN_PITCH_PX));
  return { pitch: MIN_PITCH_PX, tickHeight: 2, capacity, windowed: true };
}

/**
 * The slice of prompts a windowed rail shows. Starts on the newest prompts,
 * follows the active prompt lazily (see WINDOW_MARGIN), and can be shifted by
 * hand (wheel / "+N" clicks). Resets to the newest when `resetKey` changes.
 */
function useRailWindow(
  count: number,
  capacity: number,
  activeIndex: number,
  resetKey: string,
): { start: number; end: number; shift: (delta: number) => void } {
  const maxStart = Math.max(0, count - capacity);
  // null = pinned to the newest prompts.
  const [start, setStart] = useState<number | null>(null);

  useEffect(() => setStart(null), [resetKey]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const margin = Math.min(WINDOW_MARGIN, Math.floor((capacity - 1) / 2));
    setStart((prev) => {
      let next = clamp(prev ?? maxStart, 0, maxStart);
      if (activeIndex < next + margin) next = activeIndex - margin;
      else if (activeIndex > next + capacity - 1 - margin) {
        next = activeIndex - capacity + 1 + margin;
      }
      return clamp(next, 0, maxStart);
    });
  }, [activeIndex, capacity, maxStart]);

  const shift = useCallback(
    (delta: number) =>
      setStart((prev) => clamp((prev ?? maxStart) + delta, 0, maxStart)),
    [maxStart],
  );

  const resolved = clamp(start ?? maxStart, 0, maxStart);
  return { start: resolved, end: Math.min(count, resolved + capacity), shift };
}

/** Fade whichever rail edges have hidden prompts beyond them. */
function edgeFadeMask(top: boolean, bottom: boolean): string | undefined {
  if (!top && !bottom) return undefined;
  const fade = `${EDGE_FADE_PX}px`;
  return `linear-gradient(to bottom, ${top ? "transparent" : "black"}, black ${fade}, black calc(100% - ${fade}), ${bottom ? "transparent" : "black"})`;
}

function EdgeCount({
  hidden,
  label,
  onClick,
}: {
  hidden: number;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      tabIndex={hidden === 0 ? -1 : undefined}
      onClick={onClick}
      className={cn(
        // Wider than the tick column; spills into the rail's side padding.
        "-mx-1 w-[calc(100%+0.5rem)] text-center text-[9px] leading-none tabular-nums text-muted-foreground/70 hover:text-foreground",
        hidden === 0 && "invisible",
      )}
      style={{ height: EDGE_LABEL_PX }}
    >
      +{hidden}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Widget
// ---------------------------------------------------------------------------

const POPOVER_SELECTOR = "[data-threadline-popover]";
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/**
 * Whether an input event means the user is taking over the timeline, which
 * cancels a jump in flight and releases the clicked prompt's pin. Scrolling or
 * typing inside the popover (its list, its filter) doesn't count, and neither
 * does a bare modifier press — that's usually the start of the next shortcut,
 * and releasing the pin there would make "next" re-land on the same prompt.
 */
function isUserTakeover(event: Event): boolean {
  if (event.target instanceof Element && event.target.closest(POPOVER_SELECTOR)) return false;
  if (event instanceof KeyboardEvent && MODIFIER_KEYS.has(event.key)) return false;
  return true;
}

// The popover scrolls at whichever comes first: this many prompt rows, 70vh, or
// the space Radix actually has on screen. Beyond the row cap the next row peeks
// under the fold as a scroll affordance.
const MAX_VISIBLE_PROMPTS = 9;
const PROMPT_ROW_PX = 32; // one truncated row: px-2 py-1.5, text-sm
const POPOVER_CHROME_PX = 40; // sticky header (bordered) + list padding
const FILTER_ROW_PX = 36; // filter input (h-7) + its top margin
// Threads longer than this get a filter box in the popover.
const FILTER_MIN_PROMPTS = 15;

function popoverMaxHeight(withFilter: boolean): string {
  const chrome = POPOVER_CHROME_PX + (withFilter ? FILTER_ROW_PX : 0);
  // Fallback for the first frame, before Radix measures the available height.
  return `min(${chrome + MAX_VISIBLE_PROMPTS * PROMPT_ROW_PX}px, 70vh, var(--radix-hover-card-content-available-height, 70vh))`;
}

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

// Command palette actions run outside the overlay's React tree; they ask the
// mounted Navigator to step via this bus. Detail: -1 (previous) or 1 (next).
const STEP_EVENT = "threadline:step";
const stepBus = new EventTarget();

function Navigator() {
  const { threadId } = useBbContext();
  const { values } = useSettings();
  const position = readPosition(values?.position);
  const followHover = readBool(values?.scrollToHover, true);
  const hideBuiltInToc = readBool(values?.hideBuiltInToc, true);
  const { shortcuts } = useShortcuts();
  const previousShortcut = useMemo(
    () => (shortcuts === null ? null : parseShortcut(shortcuts.previous)),
    [shortcuts],
  );
  const nextShortcut = useMemo(
    () => (shortcuts === null ? null : parseShortcut(shortcuts.next)),
    [shortcuts],
  );
  const { ordinalOf, prompts } = useOutline(threadId);
  // Not gated on our prompts: the outline empties on every thread switch while
  // it refetches, which would flash BB's table of contents and jolt the
  // conversation 32px. display:none (not visibility:hidden) so its column never
  // takes space — BB only adds that column at 3+ prompts, so reserving it would
  // still shift the layout, and leave a dead gap beside the rail.
  useHideBuiltInToc(hideBuiltInToc);
  const scrollActiveId = useActivePrompt(prompts);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // The pinned click wins over scroll-based detection until the user scrolls.
  const activeId = pinnedId ?? scrollActiveId;
  const anchor = usePaneAnchor(position, `${threadId ?? ""}:${prompts.length}`);
  // The jump in flight, if any. A newer jump retargets it; a thread switch or
  // unmount cancels it, so it never steers a timeline that isn't ours.
  const jumpRef = useRef<AbortController | null>(null);
  // Paging in an old prompt can take seconds; the target tick pulses meanwhile.
  const [jumpingId, setJumpingId] = useState<string | null>(null);

  const go = useCallback(
    (id: string) => {
      jumpRef.current?.abort();
      const controller = new AbortController();
      jumpRef.current = controller;
      setJumpingId(id);
      // Navigation centers the row, but scroll-based detection uses a near-top
      // line and would resolve to the previous prompt — so mark the clicked
      // prompt active optimistically until the next manual scroll.
      setPinnedId(id);
      // Any manual scroll or key press hands control back instead of
      // fighting the user.
      const abort = (event: Event) => {
        if (isUserTakeover(event)) controller.abort();
      };
      window.addEventListener("wheel", abort, { passive: true });
      window.addEventListener("touchmove", abort, { passive: true });
      window.addEventListener("keydown", abort);
      navigateToRow(id, ordinalOf, controller.signal)
        .catch(() => false)
        .then((landed) => {
          // Never reached it (and not cancelled): don't leave the highlight on
          // a prompt we never showed.
          if (!landed && !controller.signal.aborted) {
            setPinnedId((pinned) => (pinned === id ? null : pinned));
          }
        })
        .finally(() => {
          window.removeEventListener("wheel", abort);
          window.removeEventListener("touchmove", abort);
          window.removeEventListener("keydown", abort);
          if (jumpRef.current === controller) {
            jumpRef.current = null;
            setJumpingId(null);
          }
        });
    },
    [ordinalOf],
  );

  // A pin or jump from another thread must not carry over to this one.
  useEffect(() => {
    setPinnedId(null);
    return () => {
      jumpRef.current?.abort();
      jumpRef.current = null;
      setJumpingId(null);
    };
  }, [threadId]);

  // Release the optimistic pin once the user scrolls or navigates by hand.
  useEffect(() => {
    if (pinnedId === null) return;
    const release = (event: Event) => {
      if (isUserTakeover(event)) setPinnedId(null);
    };
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

  // Previous / next prompt, from the keyboard shortcuts or the command palette.
  const step = useCallback(
    (delta: number) => {
      if (prompts.length === 0) return;
      const from = activeIndex >= 0 ? activeIndex : delta < 0 ? prompts.length : -1;
      const next = clamp(from + delta, 0, prompts.length - 1);
      if (next !== activeIndex) go(prompts[next].id);
    },
    [prompts, activeIndex, go],
  );

  // Capture phase + stopPropagation so the pin-release listener above doesn't
  // immediately undo the jump's pin.
  useEffect(() => {
    if (previousShortcut === null && nextShortcut === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (recordingShortcut) return;
      let delta = 0;
      if (previousShortcut !== null && matchesShortcut(event, previousShortcut)) {
        delta = -1;
      } else if (nextShortcut !== null && matchesShortcut(event, nextShortcut)) {
        delta = 1;
      }
      // Off a thread (or on an empty one) the keys aren't ours: let them through.
      if (delta === 0 || prompts.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      step(delta);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [previousShortcut, nextShortcut, step, prompts.length]);

  useEffect(() => {
    const onStep = (event: Event) => step((event as CustomEvent<number>).detail);
    stepBus.addEventListener(STEP_EVENT, onStep);
    return () => stepBus.removeEventListener(STEP_EVENT, onStep);
  }, [step]);

  // --- Rail ---
  const paneHeight = anchor?.height ?? window.innerHeight;
  const layout = railLayout(prompts.length, paneHeight);
  const { start, end, shift } = useRailWindow(
    prompts.length,
    layout.capacity,
    activeIndex,
    threadId ?? "",
  );
  const wheelRef = useRef(0);
  const onRailWheel = (event: WheelEvent) => {
    // Wheeling the rail isn't a timeline scroll: keep a clicked prompt pinned.
    event.stopPropagation();
    if (!layout.windowed) return;
    wheelRef.current += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const steps = Math.trunc(wheelRef.current / WHEEL_STEP_PX);
    if (steps === 0) return;
    wheelRef.current -= steps * WHEEL_STEP_PX;
    shift(steps);
  };
  const hiddenAbove = start;
  const hiddenBelow = prompts.length - end;
  const page = Math.max(1, layout.capacity - 1);

  // --- Popover ---
  const [hoverOpen, setHoverOpen] = useState(false);
  const [filterFocused, setFilterFocused] = useState(false);
  const [query, setQuery] = useState("");
  // Stay open while the filter has focus, even if the pointer drifts off.
  const open = hoverOpen || filterFocused;
  const withFilter = prompts.length > FILTER_MIN_PROMPTS;
  const filtering = query.trim() !== "";
  const scrollerRef = useRef<HTMLDivElement>(null);
  // The tick under the pointer. `nonce` bumps on every mouseenter so
  // re-hovering the same tick re-aligns even after a manual popover scroll.
  const [hover, setHover] = useState<{ index: number; nonce: number } | null>(null);
  const hoverIndex = hover?.index;
  const hoverNonce = hover?.nonce;
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;

  // The filter can unmount while focused (the thread drops to 15 prompts or
  // fewer, or empties), and then never fires blur — which would pin the
  // popover open.
  useEffect(() => {
    if (!withFilter) setFilterFocused(false);
  }, [withFilter]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setHover(null); // reopen starts from the active prompt
  }, [open]);

  // The one owner of the popover's scroll. On open it targets the active
  // prompt; with hover sync on, it then follows the hovered tick. While the
  // rail shows every prompt, a tick's place on the rail mirrors its row's place
  // in the list, so the row lines up with the tick. A windowed rail or a filter
  // breaks that mapping, so there the target row is centered instead — and
  // hover sync pauses while filtering. Only open/hover re-run this: the list
  // must not jump while the user reads it.
  useEffect(() => {
    if (!open) return;
    const hovered = followHover && !filtering ? hoverIndex : undefined;
    if (hoverNonce !== undefined && hovered === undefined) return;
    const target = hovered ?? activeIndexRef.current;
    if (target < 0) return;
    const frame = requestAnimationFrame(() => {
      const scroller = scrollerRef.current;
      if (scroller === null) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const behavior: ScrollBehavior = hovered === undefined || reduce ? "auto" : "smooth";
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (followHover && !layout.windowed && !filtering) {
        const fraction = prompts.length > 1 ? target / (prompts.length - 1) : 0;
        scroller.scrollTo({ top: fraction * max, behavior });
        return;
      }
      const row = scroller.querySelector<HTMLElement>(`[data-prompt-index="${target}"]`);
      if (row === null) return;
      const offset = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      const top = scroller.scrollTop + offset - (scroller.clientHeight - row.offsetHeight) / 2;
      scroller.scrollTo({ top: clamp(top, 0, max), behavior });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, hoverIndex, hoverNonce]);

  const rows = useMemo(() => {
    const all = prompts.map((prompt, index) => ({ prompt, index }));
    const needle = query.trim().toLowerCase();
    if (needle === "") return all;
    return all.filter(({ prompt }) => prompt.preview.toLowerCase().includes(needle));
  }, [prompts, query]);

  const shortcutHint = [previousShortcut, nextShortcut]
    .flatMap((shortcut) => (shortcut === null ? [] : [formatShortcut(shortcut, IS_MAC)]))
    .join(" ");

  if (threadId === null || prompts.length === 0) return null;

  return (
    <HoverCard.Root
      open={open}
      onOpenChange={setHoverOpen}
      openDelay={90}
      closeDelay={140}
    >
      <HoverCard.Trigger asChild>
        <div
          role="navigation"
          aria-label="Jump to a prompt in this conversation"
          onWheel={onRailWheel}
          className="fixed z-40 flex flex-col items-center rounded-lg border border-border/50 bg-card/60 px-1 py-2.5 opacity-80 shadow-sm backdrop-blur-sm transition-[opacity,background-color,border-color] duration-150 hover:border-border hover:bg-card hover:opacity-100"
          style={{
            right: anchor === null ? 6 : anchor.right + 6,
            top: anchor === null ? "50%" : anchor.top,
            transform: anchor === null ? "translateY(-50%)" : anchor.transform,
          }}
        >
          {layout.windowed && (
            <EdgeCount
              hidden={hiddenAbove}
              label={`Show ${hiddenAbove} earlier prompts`}
              onClick={() => shift(-page)}
            />
          )}
          <div
            className="flex w-[18px] flex-col"
            style={{
              maskImage: edgeFadeMask(hiddenAbove > 0, hiddenBelow > 0),
              WebkitMaskImage: edgeFadeMask(hiddenAbove > 0, hiddenBelow > 0),
            }}
          >
            {prompts.slice(start, end).map((prompt, offset) => {
              const index = start + offset;
              const isActive = index === activeIndex;
              return (
                <button
                  key={prompt.id}
                  type="button"
                  title={prompt.preview}
                  aria-label={`Prompt ${index + 1}: ${prompt.preview}`}
                  onClick={() => go(prompt.id)}
                  onMouseEnter={() => {
                    // With hover sync off, a recorded hover would only stop
                    // the popover from opening on the active prompt.
                    if (!followHover) return;
                    setHover((prev) => ({ index, nonce: (prev?.nonce ?? 0) + 1 }));
                  }}
                  className="group flex w-full items-center justify-end"
                  style={{ height: layout.pitch }}
                >
                  <span
                    className={cn(
                      "rounded-full transition-all",
                      prompt.id === jumpingId && "animate-pulse",
                      isActive
                        ? "bg-foreground"
                        : "bg-muted-foreground/40 group-hover:bg-muted-foreground",
                    )}
                    style={{
                      height: layout.tickHeight,
                      width: isActive ? 18 : tickWidth(prompt.preview),
                    }}
                  />
                </button>
              );
            })}
          </div>
          {layout.windowed && (
            <EdgeCount
              hidden={hiddenBelow}
              label={`Show ${hiddenBelow} later prompts`}
              onClick={() => shift(page)}
            />
          )}
        </div>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          ref={scrollerRef}
          data-threadline-popover=""
          side="left"
          align="center"
          sideOffset={8}
          collisionPadding={12}
          style={{ maxHeight: popoverMaxHeight(withFilter), width: "22rem" }}
          className="z-50 flex flex-col overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground shadow-md"
        >
          <div className="sticky top-0 z-10 border-b border-border bg-popover px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-medium">Your prompts</span>
              <span className="flex items-center gap-2 tabular-nums">
                {shortcutHint !== "" && (
                  <span title="Previous / next prompt">{shortcutHint}</span>
                )}
                <span>
                  {activeIndex >= 0 ? `${activeIndex + 1} / ` : ""}
                  {prompts.length}
                </span>
              </span>
            </div>
            {withFilter && (
              <input
                type="search"
                value={query}
                placeholder="Filter prompts"
                aria-label="Filter prompts"
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setFilterFocused(true)}
                onBlur={() => setFilterFocused(false)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && rows.length > 0) {
                    // Don't let the pin-release listener undo this jump's pin.
                    event.stopPropagation();
                    go(rows[0].prompt.id);
                  } else if (event.key === "Escape") {
                    event.currentTarget.blur();
                  }
                }}
                className="mt-2 h-7 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
          </div>
          <div className="p-1">
            {rows.length === 0 && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">No matches</div>
            )}
            {rows.map(({ prompt, index }) => {
              const isActive = index === activeIndex;
              // Hovering the tick can't trigger the row's CSS :hover, so mirror
              // it; active (bg-muted) still wins so the two stay distinct.
              const isHovered =
                followHover && !filtering && !isActive && index === hoverIndex;
              return (
                <button
                  key={prompt.id}
                  data-prompt-index={index}
                  type="button"
                  onClick={() => go(prompt.id)}
                  className={cn(
                    // Selected uses the stronger token (bg-muted); hover uses a
                    // translucent bg-accent/60 so the two states stay distinct.
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                    isActive
                      ? "bg-muted text-foreground"
                      : isHovered
                        ? "bg-accent/60 text-accent-foreground"
                        : "hover:bg-accent/60 hover:text-accent-foreground",
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

// ---------------------------------------------------------------------------
// Settings: shortcut recorder
// ---------------------------------------------------------------------------

const SHORTCUT_ACTIONS: { action: ShortcutAction; label: string }[] = [
  { action: "previous", label: "Previous prompt" },
  { action: "next", label: "Next prompt" },
];

function ShortcutRecorder({
  label,
  value,
  conflictsWith,
  onSave,
}: {
  label: string;
  /** Canonical shortcut text; "" = disabled. */
  value: string;
  /** The other action's shortcut and label, to refuse a duplicate. */
  conflictsWith: { value: string; label: string };
  onSave: (value: string | null) => Promise<void>;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseShortcut(value);

  const save = useCallback(
    (next: string | null) => {
      setRecording(false);
      onSave(next).then(
        () => setError(null),
        () => setError("Couldn't save the shortcut."),
      );
    },
    [onSave],
  );

  // While recording, swallow every keydown (capture phase, before BB's own
  // shortcuts) and turn it into a shortcut. Escape cancels; Backspace/Delete
  // clears (disables); modifiers alone wait for the key.
  useEffect(() => {
    if (!recording) return;
    recordingShortcut = true;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const bare = !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      if (bare && (event.key === "Escape" || event.key === "Tab")) {
        setRecording(false);
        return;
      }
      if (bare && (event.key === "Backspace" || event.key === "Delete")) {
        save("");
        return;
      }
      const result = recordShortcut(event);
      if (result.kind === "pending") return;
      if (result.kind === "invalid") {
        setError(result.reason);
        return;
      }
      const text = serializeShortcut(result.shortcut);
      if (text === conflictsWith.value) {
        setError(`Already used for ${conflictsWith.label}.`);
        return;
      }
      save(text);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      recordingShortcut = false;
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [recording, save, conflictsWith]);

  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {error !== null && <div className="mt-0.5 text-xs text-destructive">{error}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          aria-label={`${label} shortcut: ${parsed === null ? "none" : formatShortcut(parsed, IS_MAC)}. Click to record a new one.`}
          onClick={() => {
            setError(null);
            setRecording((was) => !was);
          }}
          onBlur={() => setRecording(false)}
          className={cn(
            "h-8 min-w-32 rounded-md border px-3 text-sm tabular-nums transition-colors",
            recording
              ? "border-ring bg-background text-muted-foreground ring-1 ring-ring"
              : "border-input bg-background text-foreground hover:bg-accent/60",
          )}
        >
          {recording
            ? "Press keys…"
            : parsed === null
              ? "None"
              : formatShortcut(parsed, IS_MAC)}
        </button>
        <button
          type="button"
          onClick={() => save(null)}
          className="h-8 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function ShortcutSettings() {
  const { shortcuts, save } = useShortcuts();
  if (shortcuts === null) {
    return <div className="py-2 text-sm text-muted-foreground">Loading…</div>;
  }
  return (
    <div className="flex flex-col">
      {SHORTCUT_ACTIONS.map(({ action, label }) => {
        const other = SHORTCUT_ACTIONS.find((entry) => entry.action !== action)!;
        return (
          <ShortcutRecorder
            key={action}
            label={label}
            value={shortcuts[action]}
            conflictsWith={{ value: shortcuts[other.action], label: other.label }}
            onSave={(value) => save(action, value)}
          />
        );
      })}
      <p className="pt-1 text-xs text-muted-foreground">
        Click a shortcut, then press the keys. Esc cancels, Backspace turns it off.
        Also in the command palette as "Threadline: Previous / Next prompt".
      </p>
    </div>
  );
}

// An app-wide overlay: mounted once per window, outside route layout, so it can
// read the active thread via useBbContext() and float over any surface.
export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "threadline-navigator",
    component: Navigator,
  });
  app.slots.settingsSection({
    id: "shortcuts",
    title: "Keyboard shortcuts",
    description: "Jump to the previous or next prompt in the current thread.",
    component: ShortcutSettings,
  });
  for (const [id, title, delta] of [
    ["previous-prompt", "Threadline: Previous prompt", -1],
    ["next-prompt", "Threadline: Next prompt", 1],
  ] as const) {
    app.slots.commandPaletteAction({
      id,
      title,
      isAvailable: ({ threadId }) => threadId !== null,
      run: () => {
        stepBus.dispatchEvent(new CustomEvent(STEP_EVENT, { detail: delta }));
      },
    });
  }
});
