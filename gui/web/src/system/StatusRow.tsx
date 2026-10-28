import { type ReactNode, useId, useState } from "react";
import { Button } from "../ui";
import { useDisabledReasonNote } from "../ui/disabledReason";
import type { SystemIconName } from "./icons";
import { clampUnit, percentOf } from "./progress";
import { StatusGlyph } from "./StatusGlyph";
import { SystemIcon } from "./SystemIcon";
import type { StatusState } from "./statusText";

export type StatusRowState =
  | "queued"
  | "running"
  | "done"
  | "needs-you"
  | "failed";

const GLYPH: Record<StatusRowState, StatusState> = {
  queued: "not-yet",
  running: "running",
  done: "done",
  "needs-you": "needs-you",
  failed: "failed",
};

type StatusRowProps = {
  state: StatusRowState;
  title: string;
  /** Numbers and plain detail: "3 of 5 sources". */
  detail?: string;
  /** 0 to 1 (held to that range), shown as a 4 px bar while running. */
  progress?: number;
  /** Words for the bar when `detail` is not a sentence of its own ("62 percent"). */
  valueText?: string;
  /** The bar's accessible name when the title alone would repeat across rows. */
  barLabel?: string;
  /** At most one action; `name` is the accessible name when the label alone would repeat. */
  action?: {
    label: string;
    name?: string;
    icon?: SystemIconName;
    onAction: () => void;
    disabledReason?: string;
  };
  /** A quieter action beside the main one, such as Save a copy next to Resume saving. */
  secondaryAction?: { label: string; name?: string; onAction: () => void };
  /** The technical cause of a failed row, behind a Details button. */
  details?: string;
  /** `list` 48, `alert` 44, `inline` 32. */
  density?: "list" | "alert" | "inline";
  /** Child rows make the row expandable. */
  children?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
};

/** One line about a state someone may need to act on, or a task that runs. */
export function StatusRow({
  state,
  title,
  detail,
  progress,
  valueText,
  barLabel,
  action,
  secondaryAction,
  details,
  density = "list",
  children,
  expanded = false,
  onToggle,
}: StatusRowProps) {
  const childrenId = useId();
  const detailsId = useId();
  const reason = useDisabledReasonNote(action?.disabledReason);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const cause = details?.trim();
  const showDetails = state === "failed" && Boolean(cause);
  if (!showDetails && detailsOpen) setDetailsOpen(false);
  const expandable = Boolean(children);
  const text = (
    <>
      <span className="sys-status-title">{title}</span>
      {detail ? <span className="sys-status-detail">{detail}</span> : null}
    </>
  );
  return (
    <div className={`sys-status sys-status--${density}`} data-state={state}>
      <div className="sys-status-line">
        <StatusGlyph state={GLYPH[state]} progress={progress} colon />
        {expandable ? (
          <button
            type="button"
            className="sys-status-text sys-status-toggle"
            aria-expanded={expanded}
            aria-controls={expanded ? childrenId : undefined}
            onClick={onToggle}
          >
            {text}
          </button>
        ) : (
          <span className="sys-status-text">{text}</span>
        )}
        {action || secondaryAction || showDetails ? (
          <div className="sys-status-actions">
            {showDetails ? (
              <Button
                aria-expanded={detailsOpen}
                aria-controls={detailsOpen ? detailsId : undefined}
                aria-label={`Details for ${title}`}
                onClick={() => setDetailsOpen((open) => !open)}
              >
                Details
              </Button>
            ) : null}
            {secondaryAction ? (
              <Button
                aria-label={secondaryAction.name}
                onClick={secondaryAction.onAction}
              >
                {secondaryAction.label}
              </Button>
            ) : null}
            {action ? (
              <Button
                variant={state === "failed" ? "primary" : "default"}
                aria-label={action.name}
                disabledReason={action.disabledReason}
                {...reason.describedBy}
                onClick={action.onAction}
              >
                {action.icon ? (
                  <SystemIcon name={action.icon} size={14} />
                ) : null}
                {action.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {reason.note}
      {showDetails && detailsOpen ? (
        <p id={detailsId} className="sys-status-cause">
          {cause}
        </p>
      ) : null}
      {state === "running" && progress !== undefined ? (
        <div
          className="sys-status-bar"
          role="progressbar"
          aria-label={barLabel ?? title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentOf(progress)}
          aria-valuetext={
            valueText ?? (detail || `${percentOf(progress)} percent`)
          }
        >
          <span style={{ inlineSize: `${clampUnit(progress) * 100}%` }} />
        </div>
      ) : null}
      {expandable && expanded ? (
        <div id={childrenId} className="sys-status-children">
          {children}
        </div>
      ) : null}
    </div>
  );
}
