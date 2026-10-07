# Sharecut Studio UI library

Intentional in-house chrome library under [`src/ui/`](../src/ui/). **No Radix / shadcn / Tailwind.** Domain folders (`timeline/`, `layout/` transport chrome, `inspector/` views) compose this library; they do not reimplement overlays, menus, or pressed toggles.

## Library vs domain

Storybook **Style guide → Start here** provides a task-oriented index and
live type, spacing, and control-state examples. Use it to find a component;
use this contract to decide where code and behavior belong.

| In the library (`ui/`) | Out of the library (domain) |
|------------------------|-----------------------------|
| Button, ToggleButton, Field, FieldRow, InlineError | ClipBlock, TrackLane, Playhead |
| Dialog, Menu, BottomSheet, `useDialogModal` | Timeline zoom / selection math |
| CommandButton, CommandMenuItem, `useCommand` | Pipeline param schemas |
| Icon (stroke SVGs, filled transport glyphs), LoadingScreen, ErrorScreen, FocusPull, DefinitionList | Comment domain (`comments/` — use library Button/Field) |
| SegmentedControl, Pill, Timecode, EmptyState | Transport wiring (`layout/TransportBar` over the presentational `layout/TransportFrame` and `layout/TransportPlayControls`); status wiring (`layout/StatusBar` over `layout/PipelineStatusChip`) |

## Public API

Import from [`src/ui/index.ts`](../src/ui/index.ts) (or `../ui`). Hooks used by overlays (`useDialogModal`, `useCommand`) are public.

## Styling

- Colors / space / radius: CSS variables from [`src/styles/theme/`](../src/styles/theme/) only.
- Library layout styles: [`src/styles/partials/ui.css`](../src/styles/partials/ui.css) (Dialog/Menu/Field + **`.ui-control`**).
- Stylelint: no raw hex outside theme files.

### `.ui-control` interaction primitive

`Button`, `ToggleButton`, and `CommandButton` (including `bare`, which the transport `LayoutToggle` / `LayoutRestoreChip` use) always apply `ui-control`. Domain classes may set padding / min-size / grouping layout; they must **not** re-declare `:hover` / `:focus-visible` / pressed paint unless a documented exception (e.g. stale-pill warning outline). Default `.ui-control:hover` (the `--color-hover` wash) does **not** apply to the primary / danger / link variants, `.pill`, `.status-chip`, `.status-pipeline`, `.trk-btn.mute` / `.solo`, or `.comment-mode-btn`; those exclusions sit inside `:where()` so the wash stays at (0,2,0) and any component that paints its own control (transport strip, Listen card) wins. Action pills still use their outline-on-hover exception. Pressed is the selected chip (`--color-chip-selected`) from `.ui-control`'s base rule; segment groups (`SegmentedControl`, which `ToolModeToggle` renders) keep the chip on hover. Hover is a wash. Default toggles and grouped segments use a neutral selected chip; standalone quiet toggles and tabs use full-strength text and a neutral underline. Checked menu radios add a check mark. The phone navigation current-location indicator is the documented accent exception.

| Modifier | Use |
|----------|-----|
| (default) | Transparent fill with a `--color-border-strong` contour; hover adds the `--color-hover` wash; pressed is the selected chip |
| `.primary` | Copper solid fill (`--color-accent-solid`); one per context |
| `.danger` | Destructive text/border |
| `.ui-control--quiet` or `[data-ui-kind="tab"]` | Standalone tabs / quiet toggles — transparent selected fill with neutral underline; grouped segments override this with a selected chip |
| `.ui-control--compact` | Transport icons, M/S |

Pressed selectors: `.ui-control[aria-pressed="true"]` and `.ui-control.active` (alias during migrate). Hover is gated behind `@media (hover: hover) and (pointer: fine)`. Focus ring uses `:focus-visible` only (2px `--color-accent` outline).

Product-facing state table: [`ux/pages/brand.md`](../../ux/pages/brand.md) § Mixing-room control states. Timeline canvas widgets are out of this primitive.

## Composition recipes

Keep editor controls compact. Reading forms (`.home-screen`, `.review-shell`,
`.record-shell`, `.bootstrap-wizard`) give shared actions a `--touch-min`
minimum height and reading-body text; labels, hints, and errors use
`--font-size-body`. Dialog close buttons and Share actions/checkbox labels also
meet `--touch-min`. This is a target-size rule, not a global increase in mixer
density. Segmented controls still need context-specific phone treatment.

For a simple choice dialog, use a grid body with `--space-6` between task
sections, `--space-1` within related options, and `--space-4` between feedback
and actions. Bounce is the current example. Do not combine a section gap with
child margins that count the same separation twice. Share's more complex list
composition still uses its existing margins; see the [consistency audit](../../../docs/design-system-audit.md).

`Field` accepts arbitrary child controls. Give hints/errors unique `hintId` /
`errorId` props, reference the visible messages from the child's
`aria-describedby`, and set `aria-invalid` on invalid controls. Remove the error
ID from that reference when the error disappears. Use `useId()` for repeated
instances. Field does not clone children or infer which control an error belongs
to. Its stories demonstrate both associations.

`DefinitionList` is semantic markup whose current visual composition belongs to
`.inspector`; its story renders inside that context. Inline navigation actions
use `Button variant="link"`, including the shortcut/gesture cross-links.

## Keyboard governance

| Concern | Owner |
|---------|--------|
| DAW shortcuts (Space, B, zoom, …) | [`keymap/listener.ts`](../src/keymap/listener.ts) → `execute` |
| Overlay Escape / Tab trap / menu arrows | Library modules (`useDialogModal`, `Menu`) — allowlisted in `commands/governance.test.ts` |
| Bottom-tabs resize (ArrowUp/Down) | [`layout/BottomTabsSplitterView.tsx`](../src/layout/BottomTabsSplitterView.tsx) — allowlisted separator widget (live adapter `BottomTabsSplitter`) |
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
- **`ToggleButton` (`aria-pressed`):** toolbars and mode strips (shell tabs, audition Full mix / Edited stems / Original, Select/Blade). Do not invent a third pattern.

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
| `Dialog` | Modal scrim + panel + header; uses `useDialogModal`. `footer` pins actions under the scrolling body; `phoneSheet` makes it a full-width sheet from the bottom edge on the phone shell |
| `InlineConfirm` | Two-step destructive confirmation in place of its trigger: the consequence, **Keep** (focused) then a danger action; use it inside an open `Dialog` instead of stacking a second one |
| `Menu` / `CommandMenuItem` / `MenuSection` / `MenuSeparator` | Popup menu + command items; labeled groups, and a divider between related items inside one group |
| `BottomSheet` | Phone/tablet peek sheet (non-modal) with optional Expand/Collapse controls and no drag handle |
| `CloseButton` | Shared close affordance for `Dialog` and `BottomSheet`: named "Close" (Esc also dismisses) |
| `UndoToast` | Polite `role="status"` toast with Undo / Dismiss; auto-dismiss pauses on hover, focus, or a disabled Undo |
| `useDialogModal` | Focus trap / Escape / inert / restore (`mode: modal \| sheet`; `returnFocusRef` picks where focus returns) |
| `useOutsidePointerDown` | Window `pointerdown` outside a floating panel and its trigger → close (`Menu`, the timeline join popover) |
| `useResizeObserver` | Element resize → latest callback from one `ResizeObserver` (targets: elements, refs or getters, re-observed when one changes; `enabled` flag). The only place the GUI constructs a `ResizeObserver` (transport collapse, timeline fit, waveform layer height, join popover placement); tests stub it with `stubResizeObserver()` (`src/test/resizeObserver.ts`), the only ResizeObserver test double besides the global no-op in `src/test/setup.ts` (enforced by a governance test) |
| `Icon` | Compact stroke icons for transport / tools (`currentColor`); play, pause, and stop are filled |
| `SegmentedControl` | Track of quiet `ToggleButton`s (audition Full mix / Edited stems / Original); themed on panes, dark in the transport, radio rows in a `Menu` |
| `Pill` | Read-only status chip (`neutral` / `ok` / `warning` / `audition`) |
| `Timecode` | Tabular playhead readout: large current time, muted total |
| `EmptyState` | Quiet empty list or panel text (no fill or border, so it never reads as a disabled field). `as="li"` inside lists, `as="div"` in other blocks; do not add per-panel empty classes. Not for hints or notes (use the surface's note text) |
| `FocusPull` | View-keyed lobby/room transition: 200ms outgoing blur/fade, then 250ms incoming fade/sharpen; initial mount stays static and reduced motion visually cuts instantly |
| `LevelMeter` | Presentational peak meter (`role="meter"`, clamped `aria-valuenow`, polite clip announcement). Display helpers in `ui/metering.ts` (`dbToFraction`, `zoneForDb`, `formatDb`, `ariaValueNow`); DSP (`peakDbFromSamples`, `decayPeakHold`, `stepMeter`) in `audio/metering.ts`; `audio/usePeakMeter` owns the rAF loop and `record/useInputPeakDb` adapts a mic stream. Exists but not yet wired into DeviceCheck / the record room (#174) |
| `DefinitionList`, screens | Existing chrome |
| `InspectorSeekFooterView` / `InspectorSeekFooter` | Inspector seek + play-around footer: props-only view; the adapter wires DAW seek and audition |

## Overlays

- **Modal** (`Dialog`, CommandPalette, Bounce): shared Dialog portals to `document.body`, outside inert application chrome; `aria-modal`, focus trap, `inert` on `[data-daw-app-chrome]`, focus restore. Open one modal at a time; phone Pipeline parameters suspend while the model-download dialog is open. Panels cap to `max-height: min(90dvh, 40rem)`; the header stays pinned and `.command-palette-body` is the only overlay scroller (`.share-dialog-body` is layout-only). The scrolling body is a named keyboard-focusable region, including while every form control is disabled.
- **Sheet** (`BottomSheet`): peek / non-modal — Escape + initial focus + restore; no chrome `inert`, no Tab trap.
- **Menu:** Escape, outside click, arrow keys, focus restore; Tab or Shift+Tab leaves the menu and closes it without moving focus back; sections (`role="group"`) for non-menuitem content (layer checkboxes, notes). `.ui-menu-panel` caps to `min(90dvh, var(--menu-available-height))` from remaining space under the trigger and scrolls the focused item into view.
