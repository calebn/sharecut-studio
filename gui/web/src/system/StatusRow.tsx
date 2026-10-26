import { type ReactNode, useId } from "react";
import { Button } from "../ui";
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

export type StatusRowProps = {
  state: StatusRowState;
  title: string;
  /** Numbers and plain detail: "3 of 5 sources". */
  detail?: string;
  /** 0 to 1 (held to that range), shown as a 4 px bar while running. */
  progress?: number;
  /** At most one action. */
  action?: { label: string; icon?: SystemIconName; onAction: () => void };
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
  action,
  density = "list",
  children,
  expanded = false,
  onToggle,
}: StatusRowProps) {
  const childrenId = useId();
  const expandable = children !== undefined && children !== null;
  const text = (
    <>
      <span className="sys-status-title">{title}</span>
      {detail ? <span className="sys-status-detail">{detail}</span> : null}
    </>
  );
  return (
    <div className={`sys-status sys-status--${density}`} data-state={state}>
      <div className="sys-status-line">
        <StatusGlyph state={GLYPH[state]} progress={progress} />
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
        {action ? (
          <Button onClick={action.onAction}>
            {action.icon ? <SystemIcon name={action.icon} size={14} /> : null}
            {action.label}
          </Button>
        ) : null}
      </div>
      {state === "running" && progress !== undefined ? (
        <div
          className="sys-status-bar"
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentOf(progress)}
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
