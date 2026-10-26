import { useId, useState } from "react";
import { Button, Menu, MenuItem } from "../ui";
import { SystemIcon } from "./SystemIcon";

const SUBJECT = "Where this session goes";

export type SessionTarget = "start" | "end";

const TARGET_TEXT: Record<SessionTarget, string> = {
  start: "Starts the episode",
  end: "At the end",
};

export type SessionTargetChipProps = {
  target: SessionTarget;
  /** Locked once the first take landed. */
  locked?: boolean;
  onTarget?: (target: SessionTarget) => void;
};

/**
 * Where a session goes in the episode. Text only. Before the first take it
 * is a menu; after, it is a lock and the reason in words, not a control.
 */
export function SessionTargetChip({
  target,
  locked = false,
  onTarget,
}: SessionTargetChipProps) {
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  if (locked) {
    return (
      <span
        className="sys-target-chip sys-target-chip--locked"
        role="group"
        aria-label={SUBJECT}
        aria-describedby={reasonId}
      >
        <SystemIcon name="lock" size={14} />
        <span>{TARGET_TEXT[target]}</span>
        <span id={reasonId} className="sys-target-reason">
          Set when the first take landed
        </span>
      </span>
    );
  }
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={SUBJECT}
      className="ui-menu-root sys-menu sys-target-chip"
      trigger={(props) => (
        <Button
          {...props}
          className="sys-target-trigger"
          aria-label={`${SUBJECT}: ${TARGET_TEXT[target]}`}
        >
          <span>{TARGET_TEXT[target]}</span>
          <SystemIcon name="chevron-down" size={14} />
        </Button>
      )}
    >
      {(["start", "end"] as const).map((value) => (
        <MenuItem
          key={value}
          onSelect={() => {
            setOpen(false);
            onTarget?.(value);
          }}
        >
          <span className="sys-target-check">
            {value === target ? <SystemIcon name="check" size={14} /> : null}
          </span>
          {TARGET_TEXT[value]}
        </MenuItem>
      ))}
    </Menu>
  );
}
