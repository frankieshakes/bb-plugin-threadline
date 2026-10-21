// Keyboard shortcuts, stored as text like "Ctrl+Alt+ArrowUp". BB's keybinding
// settings only cover host commands, so Threadline records, stores, and matches
// its own. Shared by server.ts (validation) and app.tsx (recording, matching).

export interface Shortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod: boolean;
  /** A physical key: "a"–"z", "0"–"9", punctuation, " ", or a named key ("ArrowUp", "F5"). */
  key: string;
}

export type ShortcutAction = "previous" | "next";

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  previous: "Ctrl+Alt+ArrowUp",
  next: "Ctrl+Alt+ArrowDown",
};

// Realtime channel the server broadcasts on after every shortcut change, so
// each open window picks it up.
export const SHORTCUTS_CHANNEL = "shortcuts";

const MODIFIERS: Record<string, keyof Omit<Shortcut, "key">> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  mod: "mod",
};

const KEY_ALIASES: Record<string, string> = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  tab: "Tab",
  space: " ",
};

// Punctuation by physical key: Shift and Option rewrite event.key for these
// ("[" becomes "{" or "“"), event.code does not.
const PUNCTUATION_CODES: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"]);

/** Parse "Ctrl+Alt+ArrowUp"-style text. Null when empty or malformed. */
export function parseShortcut(text: string): Shortcut | null {
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return null;
  const shortcut: Shortcut = {
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    mod: false,
    key: "",
  };
  for (const [index, part] of parts.entries()) {
    const lower = part.toLowerCase();
    if (index < parts.length - 1) {
      const modifier = MODIFIERS[lower];
      if (modifier === undefined) return null;
      shortcut[modifier] = true;
      continue;
    }
    // The last part is the key itself.
    const alias = KEY_ALIASES[lower];
    if (alias !== undefined) shortcut.key = alias;
    else if (/^f([1-9]|1[0-2])$/.test(lower)) shortcut.key = part.toUpperCase();
    else if (part.length === 1) shortcut.key = lower;
    else return null;
  }
  return shortcut;
}

/** Canonical text form, the inverse of parseShortcut: "Ctrl+Alt+ArrowUp". */
export function serializeShortcut(shortcut: Shortcut): string {
  const mods = [
    shortcut.mod && "Mod",
    shortcut.ctrl && "Ctrl",
    shortcut.alt && "Alt",
    shortcut.shift && "Shift",
    shortcut.meta && "Cmd",
  ].filter((mod): mod is string => typeof mod === "string");
  const key = shortcut.key === " " ? "Space" : shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return [...mods, key].join("+");
}

/** The physical key an event came from, in Shortcut["key"] form. */
function keyFromEvent(event: KeyboardEvent): string {
  const letter = /^Key([A-Z])$/.exec(event.code);
  if (letter !== null) return letter[1].toLowerCase();
  const digit = /^Digit(\d)$/.exec(event.code);
  if (digit !== null) return digit[1];
  if (event.code === "Space") return " ";
  return PUNCTUATION_CODES[event.code] ?? event.key;
}

export function matchesShortcut(
  event: KeyboardEvent,
  shortcut: Shortcut,
  isMac: boolean,
): boolean {
  const ctrl = shortcut.ctrl || (shortcut.mod && !isMac);
  const meta = shortcut.meta || (shortcut.mod && isMac);
  if (
    event.ctrlKey !== ctrl ||
    event.metaKey !== meta ||
    event.altKey !== shortcut.alt ||
    event.shiftKey !== shortcut.shift
  ) {
    return false;
  }
  return keyFromEvent(event).toLowerCase() === shortcut.key.toLowerCase();
}

export type RecordResult =
  | { kind: "pending" } // only modifiers so far
  | { kind: "invalid"; reason: string }
  | { kind: "ok"; shortcut: Shortcut };

/**
 * Turn a keydown into a shortcut while recording. Needs Ctrl, Alt, or Cmd
 * (Shift alone would hijack typing) unless it's a function key.
 */
export function recordShortcut(event: KeyboardEvent): RecordResult {
  if (MODIFIER_KEYS.has(event.key)) return { kind: "pending" };
  const key = keyFromEvent(event);
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(key);
  const known =
    key.length === 1 ||
    isFunctionKey ||
    Object.values(KEY_ALIASES).includes(key);
  if (!known) return { kind: "invalid", reason: `${key} can't be used in a shortcut.` };
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !isFunctionKey) {
    return { kind: "invalid", reason: "Include Ctrl, Alt, or Cmd." };
  }
  return {
    kind: "ok",
    shortcut: {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
      mod: false,
      key,
    },
  };
}

const MAC_GLYPHS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};

/** Display form: "⌃⌥↑" on macOS, "Ctrl+Alt+↑" elsewhere. */
export function formatShortcut(shortcut: Shortcut, isMac: boolean): string {
  const key =
    MAC_GLYPHS[shortcut.key] ??
    (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  const ctrl = shortcut.ctrl || (shortcut.mod && !isMac);
  const meta = shortcut.meta || (shortcut.mod && isMac);
  if (isMac) {
    return `${ctrl ? "⌃" : ""}${shortcut.alt ? "⌥" : ""}${shortcut.shift ? "⇧" : ""}${meta ? "⌘" : ""}${key}`;
  }
  const mods = [ctrl && "Ctrl", shortcut.alt && "Alt", shortcut.shift && "Shift", meta && "Meta"];
  return [...mods.filter(Boolean), key].join("+");
}
