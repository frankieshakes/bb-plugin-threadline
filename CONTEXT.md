# Threadline

A prompt navigator for long BB threads: a slim vertical strip on the right edge
of a conversation, one mark per prompt the user sent, with a hover list for
scanning and jumping.

## Language

**Rail**:
The slim vertical strip pinned to the right edge of the conversation pane, one
tick per prompt. The navigator widget as a whole.
_Avoid_: widget, navigator strip

**Tick**:
One mark on the rail, representing a single user prompt. Its length varies with
preview length for a minimap look; the active prompt's tick is emphasized.
_Avoid_: marker, notch, bar

**Popover**:
The hover list that opens off the rail, showing every prompt's preview so the
whole conversation can be scanned at once.
_Avoid_: hover card, tooltip, flyout

**Row**:
One line in the popover, corresponding to one tick / one prompt.
_Avoid_: item, entry

**Preview**:
The truncated prompt text shown in a row (and as a tick's title).
_Avoid_: snippet, summary

**Prompt**:
A message the human sent. Distinct from BB's synthetic `[bb system]` messages,
which are real timeline rows but never get a tick or a row.
_Avoid_: message (too broad), question

**Active prompt**:
The one prompt currently nearest the top of the viewport as you scroll — shown
emphasized on both its tick and its row. A click-to-jump pins it until the next
manual scroll.
_Avoid_: selected prompt, current message

**Windowed rail**:
A rail whose prompts no longer fit at the minimum tick spacing within its
height cap (half the visible pane). It shows a slice of ticks that follows the
active prompt, with `+N` counts for the hidden ones above and below.
_Avoid_: scrolling rail, paged rail
