# bb-plugin-threadline

A navigator for long conversations. It pins a slim rail to the right edge of a
thread — one marker per prompt you send. Hover the rail to see every prompt's
preview text; click a marker (or a preview) to jump the conversation to the
start of that prompt and flash it. The current prompt stays highlighted as you
scroll.

_Inspired by [Conductor](https://conductor.build), where I first encountered
this feature._

![Threadline — the prompt rail and its hover popover in a thread](docs/threadline.png)

- `server.ts` — the backend: one RPC, `outline`, that returns the current
  thread's conversation outline (`bb.sdk.threads.conversationOutline`) as the
  ordered user/assistant messages, each with a short preview.
- `app.tsx` — the frontend: an app-wide overlay
  (`app.slots.experimental_appOverlay`) that reads the active thread with
  `useBbContext()`, draws the navigator, and scrolls the timeline.

## How navigation works

The BB timeline is a **virtualized** list: an off-screen question isn't in the
DOM. Each rendered row carries `data-timeline-row-id="<id>"`, and that id equals
the outline item's `id` for user messages. To reach an off-screen question the
overlay estimates a scroll position from the question's ordinal, lets the
virtualizer realize nearby rows, then interpolates from those realized rows'
measured offsets — repeating until the target row mounts — and finishes with
`scrollIntoView({ block: "center" })` plus a brief highlight.

The active question (highlighted in the widget and popover) is whichever user
row is nearest the top of the viewport, recomputed as the timeline scrolls.

The widget is anchored to the conversation pane's right edge (the timeline
scroll element), not the app window, and re-anchors as the pane resizes — e.g.
when the right side panel opens or closes.

## Configure

One setting, **Widget position** (`position`), sets where the widget sits along
the conversation pane: `Top`, `Middle` (default), or `Bottom` (just above the
chat input). The frontend reads it reactively with `useSettings()`, so changes
apply without a reload.

```
bb plugin config threadline                     # show current values
bb plugin config threadline set position Bottom
```

## UI components

This plugin keeps only what it uses: `lib/utils.ts` (the `cn` helper) and the
`@radix-ui/react-hover-card` primitive for the popover. React, the radix portal
primitives, and the SDK are provided by BB at runtime and never bundled, so they
stay in `devDependencies` only to typecheck. To vendor more shadcn components,
`components.json` still points at the BB registry — `npx shadcn add @bb/select …`
recreates `components/ui/` on demand.

## Install

```
npm install
bb plugin install .
```

After editing sources, reload (or run `bb plugin dev` to rebuild on save):

```
bb plugin reload threadline
```

## Types & API reference

After `npm install`, the full API is on disk:

```
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts      # backend
node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts  # frontend
```

Run `bb plugin types` to sync the SDK pin to the running BB, and
`bb plugin build` before publishing a git/npm install.
