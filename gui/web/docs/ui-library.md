# Sharecut Studio UI library

Intentional in-house chrome library under [`src/ui/`](../src/ui/). **No Radix / shadcn / Tailwind.** Domain folders (`timeline/`, `layout/` transport chrome, `inspector/` views) compose this library; they do not reimplement overlays, menus, or pressed toggles.

## Library vs domain

| In the library (`ui/`) | Out of the library (domain) |
|------------------------|-----------------------------|
| Button, ToggleButton, Field, FieldRow, InlineError | ClipBlock, TrackLane, Playhead |
| Dialog, Menu, BottomSheet, `useDialogModal` | Timeline zoom / selection math |
| CommandButton, CommandMenuItem, `useCommand` | Pipeline param schemas |
| Icon (stroke SVGs, filled transport glyphs), LoadingScreen, ErrorScreen, FocusPull, FocusToggle, DefinitionList | Comment domain (`comments/` — use library Button/Field) |
| SegmentedControl, Pill, Timecode, EmptyState | Transport wiring (`layout/TransportBar` over the presentational `layout/TransportFrame`) |

## Public API

Import from [`src/ui/index.ts`](../src/ui/index.ts) (or `../ui`). Hooks used by overlays (`useDialogModal`, `useCommand`) are public.

## Styling

- Colors / space / radius: CSS variables from [`src/styles/theme/`](../src/styles/theme/) only.
- Library layout styles: [`src/styles/partials/ui.css`](../src/styles/partials/ui.css) (Dialog/Menu/Field + **`.ui-control`**).
- Stylelint: no raw hex outside theme files.

### `.ui-control` interaction primitive

`Button`, `ToggleButton`, `CommandButton` (including `bare`), and `FocusToggle` always apply `ui-control`. Domain classes may set padding / min-size / grouping layout; they must **not** re-declare `:hover` / `:focus-visible` / pressed paint unless a documented exception (e.g. stale-pill warning outline). Default `.ui-control:hover` color/border does **not** apply to `.pill`, `.status-chip`, `.status-pipeline`, `.trk-btn.mute` / `.solo`, or `.comment-mode-btn` so semantic / link-style / function colors stay intact; action pills still use their outline-on-hover exception. Quiet pressed hover wash likewise skips segment groups (`.ui-segmented`, `.tool-mode-toggle`), which keep the selected chip (`--color-chip-selected`) on hover. Every pressed toggle, segment, tab, and menu-row hover uses that one chip; the accent is never a selected state.

| Modifier | Use |
|----------|-----|
| (default) | Lane-fill chip with strong-enough border |
| `.primary` | Copper solid fill (`--color-accent-solid`); one per context |
| `.danger` | Destructive text/border |
| `.ui-control--quiet` or `[data-ui-kind="tab"]` | Tabs / segmented tools — quieter rest, still hover + focus-visible + pressed |
| `.ui-control--compact` | Transport icons, M/S |

Pressed selectors: `.ui-control[aria-pressed="true"]` and `.ui-control.active` (alias during migrate). Hover is gated behind `@media (hover: hover) and (pointer: fine)`. Focus ring uses `:focus-visible` only (2px `--color-accent` outline).

Product-facing state table: [`ux/pages/brand.md`](../../ux/pages/brand.md) § Mixing-room control states. Timeline canvas widgets are out of this primitive.

## Keyboard governance

| Concern | Owner |
|---------|--------|
| DAW shortcuts (Space, B, zoom, …) | [`keymap/listener.ts`](../src/keymap/listener.ts) → `execute` |
| Overlay Escape / Tab trap / menu arrows | Library modules (`useDialogModal`, `Menu`) — allowlisted in `commands/governance.test.ts` |
| Bottom-tabs resize (ArrowUp/Down) | [`layout/BottomTabsSplitter.tsx`](../src/layout/BottomTabsSplitter.tsx) — allowlisted separator widget |
| Pointer → same actions as keys | **Command bridge** (`CommandButton`, `CommandMenuItem`) → `execute` |

Do **not** add a second window shortcut listener for DAW commands. While a modal dialog is open, the keymap listener no-ops (`commandPaletteOpen` / `bounceDialogOpen` / `shareDialogOpen` with a project). Open menus set a non-reactive overlay gate so Space/`B` do not fire under the menu.

## Command bridge (SOLID / DRY)

```
Keymap ──┐
         ├──► execute(id) ──► registered handlers
CommandButton / CommandMenuItem ──┘
```

1. If an action is in the command catalog, UI invokes `execute(id)` — do not duplicate store mutations in click handlers (except pure UI state like “menu open”).
2. **Default pointer policy:** `skipWhen: true` (same as historical transport clicks — pointer works even when keyboard `when` would block).
3. **`respectWhen`:** optional; disables the control when `evaluateWhen` fails (keyboard parity).
4. Overlay keys (Escape, Tab, arrows) are **not** catalog commands unless product adds one.
5. Prefer `CommandButton` / `CommandMenuItem` for new chrome; raw `execute` in JSX is for domain edge cases (e.g. blade cut with pointer time args).

### `useCommand(commandId)`

Returns `{ run, enabled, label, def }` from catalog + context.

### Tabs vs ToggleButton toolbars

- **`role="tablist"` / `tab`:** real exclusive panels (e.g. CommandPalette categories).
- **`ToggleButton` (`aria-pressed`):** toolbars and mode strips (shell tabs, audition Mix/FX/Raw, Select/Blade). Do not invent a third pattern.

## A11y bar

Every interactive library component has Vitest coverage including `expectNoA11yViolations` where applicable. Prefer native controls and correct roles.

## Catalog

| Export | Role |
|--------|------|
| `Button` | `default` / `primary` / `danger` / `link` |
| `ToggleButton` | Pressed toolbars |
| `CommandButton` | Button → `execute(commandId)` |
| `useCommand` | Catalog label / enabled / `run` |
| `Field` / `FieldRow` | Labeled control + hint; horizontal nudge row |
| `InlineError` | Inline failure text |
| `Dialog` | Modal scrim + panel + header; uses `useDialogModal` |
| `Menu` / `CommandMenuItem` | Popup menu + command items |
| `BottomSheet` | Phone/tablet peek sheet (non-modal) |
| `useDialogModal` | Focus trap / Escape / inert / restore (`mode: modal \| sheet`) |
| `Icon` | Compact stroke icons for transport / tools (`currentColor`); play, pause, and stop are filled |
| `SegmentedControl` | Track of quiet `ToggleButton`s (audition Mix/FX/Raw); themed on panes, dark in the transport, radio rows in a `Menu` |
| `Pill` | Read-only status chip (`neutral` / `ok` / `warning` / `audition`) |
| `Timecode` | Tabular playhead readout: large current time, muted total |
| `EmptyState` | Quiet empty list or panel text (no fill or border, so it never reads as a disabled field) |
| `FocusPull` | View-keyed lobby/room transition: 200ms outgoing blur/fade, then 250ms incoming fade/sharpen; initial mount stays static and reduced motion visually cuts instantly |
| `LevelMeter` | Presentational peak meter (`role="meter"`, clamped `aria-valuenow`, polite clip announcement). Display helpers in `ui/metering.ts` (`dbToFraction`, `zoneForDb`, `formatDb`, `ariaValueNow`); DSP (`peakDbFromSamples`, `decayPeakHold`, `stepMeter`) in `audio/metering.ts`; `audio/usePeakMeter` owns the rAF loop and `record/useInputPeakDb` adapts a mic stream. Exists but not yet wired into DeviceCheck / the record room (#174) |
| `DefinitionList`, screens, `FocusToggle`, `InspectorSeekFooter` | Existing chrome |

## Overlays

- **Modal** (`Dialog`, CommandPalette, Bounce): `aria-modal`, focus trap, `inert` on `[data-daw-app-chrome]`, focus restore. Panels cap to `max-height: min(90dvh, 40rem)`; the header stays pinned and `.command-palette-body` is the only overlay scroller (`.share-dialog-body` is layout-only).
- **Sheet** (`BottomSheet`): peek / non-modal — Escape + initial focus + restore; no chrome `inert`, no Tab trap.
- **Menu:** Escape, outside click, arrow keys, focus restore; sections (`role="group"`) for non-menuitem content (layer checkboxes, notes). `.ui-menu-panel` caps to `min(90dvh, var(--menu-available-height))` from remaining space under the trigger and scrolls the focused item into view.
