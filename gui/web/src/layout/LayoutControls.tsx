import { COMMANDS } from "../commands/catalog";
import { ariaKeyShortcutsFor, titleWithShortcut } from "../keymap/registry";
import { useDaw } from "../state/useDaw";
import { CommandButton, Icon, pillClassName } from "../ui";
import { layoutModeCopy } from "./layoutModes";

/** One transport control: maximize the timeline, or restore from any layout. */
export function LayoutToggle() {
  const { layoutMode } = useDaw((s) => ({ layoutMode: s.layoutMode }));
  const maximized = layoutMode !== "default";
  const commandId = maximized ? "layout.default" : "layout.timeline";
  // The name says what a click does, so no aria-pressed (it would contradict it).
  const label = COMMANDS[commandId].label;
  return (
    <CommandButton
      bare
      commandId={commandId}
      className={`ui-control--compact transport-icon-btn layout-toggle-btn${maximized ? " active" : ""}`}
      aria-label={label}
      aria-keyshortcuts={ariaKeyShortcutsFor(commandId)}
      title={titleWithShortcut(label, commandId)}
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
  return (
    <CommandButton
      bare
      commandId="layout.default"
      className={pillClassName("audition", "pill--action", "layout-chip")}
      title={`${chipLabel}. ${titleWithShortcut(COMMANDS["layout.default"].label, "layout.default")}`}
      aria-keyshortcuts={ariaKeyShortcutsFor("layout.default")}
    >
      {collapsed ? "Restore" : `${chipLabel} · Restore`}
    </CommandButton>
  );
}
