import { useId, useState } from "react";
import { Button, Menu, MenuItem } from "../ui";
import { SystemIcon } from "./SystemIcon";
import {
  type SessionTargetView,
  sessionTargetMenuText,
  sessionTargetText,
} from "./sessionTargetText";

const SUBJECT = "Where this session goes";

/** Prepare's two-value target. */
export type PrepareTarget = "start" | "end";

const TARGET_TEXT: Record<PrepareTarget, string> = {
  start: "Starts the episode",
  end: "At the end",
};

export type { SessionTargetView };

/** What Edit has selected, as a timeline range; offered as the Replace entry. */
export type SessionTargetSelection = { fromSec: number; toSec: number };

type Entry = {
  key: string;
  label: string;
  checked: boolean;
  pick: () => void;
};

/** End and start always; the playhead and the selection only when Edit has them. */
function viewEntries(
  target: SessionTargetView,
  edit: {
    playheadSec?: number;
    selection?: SessionTargetSelection;
    endAfterSec?: number;
  },
  pick: (target: SessionTargetView) => void,
): Entry[] {
  const { playheadSec, selection, endAfterSec } = edit;
  const entries: Entry[] = [
    {
      key: "end",
      label: sessionTargetMenuText("end"),
      checked: target.kind === "end",
      pick: () => pick({ kind: "end", afterSec: endAfterSec }),
    },
    {
      key: "start",
      label: sessionTargetMenuText("start"),
      checked: target.kind === "start",
      pick: () => pick({ kind: "start" }),
    },
  ];
  if (playheadSec !== undefined) {
    entries.push({
      key: "insert",
      label: sessionTargetMenuText("insert", playheadSec),
      checked: target.kind === "insert",
      pick: () => pick({ kind: "insert", atSec: playheadSec }),
    });
  }
  if (selection) {
    entries.push({
      key: "replace",
      label: sessionTargetMenuText("replace"),
      checked: target.kind === "replace",
      pick: () =>
        pick({
          kind: "replace",
          fromSec: selection.fromSec,
          toSec: selection.toSec,
        }),
    });
  }
  return entries;
}

type ChipBase = {
  /** Locked once the first take landed. */
  locked?: boolean;
  /** Why the menu cannot be opened now, e.g. while a command is in flight. */
  disabledReason?: string;
  /** The session it belongs to, added to the control name. */
  session?: string;
};

/** Prepare's two words, with the two-value pick. */
type PrepareChipProps = ChipBase & {
  target: PrepareTarget;
  onTarget?: (target: PrepareTarget) => void;
  onChange?: never;
  playheadSec?: never;
  selection?: never;
  endAfterSec?: never;
};

/** A view adds insert and replace, the richer text and the Edit-driven entries. */
type ViewChipProps = ChipBase & {
  target: SessionTargetView;
  onChange?: (target: SessionTargetView) => void;
  onTarget?: never;
  /** Edit's playhead; without it the menu has no At the playhead entry. */
  playheadSec?: number;
  /** Edit's selection; without it the menu has no Replace selection entry. */
  selection?: SessionTargetSelection;
  /** The end of the last clip, shown on the end target. */
  endAfterSec?: number;
};

export type SessionTargetChipProps = PrepareChipProps | ViewChipProps;

function isPrepare(props: SessionTargetChipProps): props is PrepareChipProps {
  return typeof props.target === "string";
}

/**
 * Where a session goes in the episode. Text only. Before the first take it
 * is a menu; after, it is a lock and the reason in words, not a control.
 */
export function SessionTargetChip(props: SessionTargetChipProps) {
  const { locked = false, disabledReason, session } = props;
  const [open, setOpen] = useState(false);
  const reasonId = useId();
  const prepare = isPrepare(props);
  const text = prepare
    ? TARGET_TEXT[props.target]
    : sessionTargetText(props.target);
  const entries: Entry[] = prepare
    ? (["start", "end"] as const).map((value) => ({
        key: value,
        label: TARGET_TEXT[value],
        checked: value === props.target,
        pick: () => props.onTarget?.(value),
      }))
    : viewEntries(props.target, props, (next) => props.onChange?.(next));
  if (locked) {
    return (
      <span
        className="sys-target-chip sys-target-chip--locked"
        role="group"
        aria-label={session ? `${SUBJECT}, ${session}` : SUBJECT}
        aria-describedby={reasonId}
      >
        <SystemIcon name="lock" size={14} />
        <span>{text}</span>
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
          disabledReason={disabledReason}
          aria-label={`${SUBJECT}: ${text}${session ? `, ${session}` : ""}`}
        >
          <span>{text}</span>
          <SystemIcon name="chevron-down" size={14} />
        </Button>
      )}
    >
      {entries.map((entry) => (
        <MenuItem
          key={entry.key}
          onSelect={() => {
            setOpen(false);
            entry.pick();
          }}
        >
          <span className="sys-target-check">
            {entry.checked ? <SystemIcon name="check" size={14} /> : null}
          </span>
          {entry.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
