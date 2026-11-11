import { useId, useRef, useState } from "react";
import { Button } from "../ui";
import { StatusList } from "./StatusList";
import { StatusRow, type StatusRowState } from "./StatusRow";
import { useFocusOffDisabled } from "./useFocusOffDisabled";
import { useFocusRescue } from "./useFocusRescue";

export type AlertSlotItem = {
  /** Stable per alert; keys the row in the "+N" list. */
  id: string;
  state: StatusRowState;
  title: string;
  progress?: number;
  barLabel?: string;
  /** `timer` for a title that ticks: the live region then stays quiet. */
  titleRole?: "timer";
  action?: {
    label: string;
    name?: string;
    onAction: () => void;
    disabledReason?: string;
  };
  secondaryAction?: { label: string; name?: string; onAction: () => void };
};

export type AlertSlotProps = {
  /** Active alerts, most urgent first. The first shows; the rest sit behind "+N". */
  alerts: readonly AlertSlotItem[];
};

/**
 * The alert slot every stage shares: one 44 px Status row for the most urgent
 * alert, a "+N" chip for the rest, and the rest listed under it when opened. With
 * no alert the live region stays mounted and empty, so the slot takes no height.
 * Only the top row sits in the live region; the chip and the list are outside it.
 */
export function AlertSlot({ alerts }: AlertSlotProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const slot = useRef<HTMLDivElement>(null);
  const region = useRef<HTMLDivElement>(null);
  const chip = useRef<HTMLButtonElement>(null);
  // When the top action goes, focus has nowhere to land: the chip if it is
  // still there, else the empty region itself.
  useFocusRescue(slot, () => () => chip.current ?? region.current);
  const [top, ...rest] = alerts;
  useFocusOffDisabled(slot, top?.action?.disabledReason !== undefined);
  // The list closes by itself once nothing is left behind the chip.
  if (rest.length === 0 && expanded) setExpanded(false);
  const open = expanded && rest.length > 0;
  // A ticking line is not announced; the room's one-shot announcer speaks start and end.
  const ticking = top?.titleRole === "timer";
  const more = rest.length;
  return (
    <div className="sys-room-alert-slot" ref={slot}>
      <div className="sys-room-alert-row">
        <div
          ref={region}
          className="sys-room-alert-live"
          role="status"
          aria-live={ticking ? "off" : undefined}
          tabIndex={-1}
        >
          {top ? (
            <StatusRow
              state={top.state}
              title={top.title}
              density="alert"
              titleRole={top.titleRole}
              progress={top.progress}
              barLabel={top.barLabel}
              action={top.action}
              secondaryAction={top.secondaryAction}
            />
          ) : null}
        </div>
        {more > 0 ? (
          <Button
            ref={chip}
            className="sys-room-alert-more"
            aria-label={`${more} more ${more === 1 ? "alert" : "alerts"}`}
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
          >
            {`+${more}`}
          </Button>
        ) : null}
      </div>
      {open ? (
        <div id={listId}>
          <StatusList label="More alerts">
            {rest.map((alert) => (
              <StatusRow
                key={alert.id}
                state={alert.state}
                title={alert.title}
                density="alert"
                titleRole={alert.titleRole}
                progress={alert.progress}
                barLabel={alert.barLabel}
                action={alert.action}
                secondaryAction={alert.secondaryAction}
              />
            ))}
          </StatusList>
        </div>
      ) : null}
    </div>
  );
}
