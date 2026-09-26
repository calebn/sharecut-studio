import { ariaKeyShortcutsFor, displayShortcutFor } from "../keymap/registry";
import { useDaw } from "../state/useDaw";
import { CommandButton, Icon, pillClassName } from "../ui";
import { layoutModeCopy } from "./layoutModes";

/** One transport control: maximize the timeline, or restore from any layout. */
export function LayoutToggle() {
  const { layoutMode } = useDaw((s) => ({ layoutMode: s.layoutMode }));
  const maximized = layoutMode !== "default";
  const commandId = maximized ? "layout.default" : "layout.timeline";
  const shortcut = displayShortcutFor(commandId);
  return (
    <CommandButton
      bare
      commandId={commandId}
      className={`ui-control--compact transport-icon-btn layout-toggle-btn${maximized ? " active" : ""}`}
      aria-label="Maximize layout"
      aria-pressed={maximized}
      aria-keyshortcuts={ariaKeyShortcutsFor(commandId)}
      title={`${maximized ? "Restore layout" : "Maximize timeline"}${shortcut ? ` (${shortcut})` : ""}`}
    >
      <Icon name={maximized ? "restore" : "maximize"} />
    </CommandButton>
  );
}

/** Persistent exit from a non-default layout; lives in the transport, which no layout hides. */
export function LayoutRestoreChip({ collapsed }: { collapsed: boolean }) {
  const { layoutMode } = useDaw((s) => ({ layoutMode: s.layoutMode }));
  const { chipLabel } = layoutModeCopy(layoutMode);
  if (!chipLabel) {
    return null;
  }
  const shortcut = displayShortcutFor("layout.default");
  return (
    <CommandButton
      bare
      commandId="layout.default"
      className={pillClassName("audition", "pill--action", "layout-chip")}
      title={`${chipLabel}. Restore layout${shortcut ? ` (${shortcut})` : ""}`}
      aria-keyshortcuts={ariaKeyShortcutsFor("layout.default")}
    >
      {collapsed ? "Restore" : `${chipLabel} · Restore`}
    </CommandButton>
  );
}
