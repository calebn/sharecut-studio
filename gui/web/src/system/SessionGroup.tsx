import type { ReactNode } from "react";
import { clampUnit, percentOf } from "./progress";
import { type SessionTarget, SessionTargetChip } from "./SessionTargetChip";
import { StageHandoff, type StageHandoffProps } from "./StageHandoff";
import { StatusGlyph } from "./StatusGlyph";

type SessionGroupStatus = "idle" | "running" | "done" | "failed";

export type SessionGroupProps = {
  title: string;
  people: number;
  takes: number;
  /** "14:20". */
  duration: string;
  target: SessionTarget;
  targetLocked?: boolean;
  onTarget?: (target: SessionTarget) => void;
  /** Names the session in the target control so two sessions differ. */
  targetFor?: string;
  status: SessionGroupStatus;
  /** 0 to 1 while running. */
  progress?: number;
  /** The takes. Empty groups say so. */
  children?: ReactNode;
  /** Omit when the stage owns the one hand-off (Prepare). */
  handoff?: Pick<
    StageHandoffProps,
    "stage" | "label" | "onActivate" | "disabledReason"
  >;
};

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** A group of takes recorded together: its numbers, where it goes, how far it got. */
export function SessionGroup({
  title,
  people,
  takes,
  duration,
  target,
  targetLocked,
  onTarget,
  targetFor,
  status,
  progress = 0,
  children,
  handoff,
}: SessionGroupProps) {
  const percent = percentOf(progress);
  const statusText =
    status === "running"
      ? `Transcribing, ${percent}%`
      : status === "done"
        ? "Transcribed"
        : status === "failed"
          ? "Transcription failed"
          : "Not started";
  const ring = (
    <>
      <StatusGlyph
        text={false}
        state={
          status === "running"
            ? "running"
            : status === "done"
              ? "done"
              : status === "failed"
                ? "failed"
                : "not-yet"
        }
        progress={status === "running" ? clampUnit(progress) : undefined}
      />
      <span className="sys-group-status-text">{statusText}</span>
    </>
  );
  return (
    <section
      className="sys-group"
      tabIndex={-1}
      aria-label={title}
      data-status={status}
    >
      <header className="sys-group-header">
        <h3 className="sys-group-title">{title}</h3>
        <p className="sys-group-stats">
          {[
            plural(people, "person", "people"),
            plural(takes, "take", "takes"),
            duration,
          ].join(" · ")}
        </p>
        <SessionTargetChip
          target={target}
          locked={targetLocked}
          onTarget={onTarget}
          session={targetFor}
        />
        {status === "running" ? (
          <span
            className="sys-group-status"
            role="progressbar"
            aria-label={`${title} transcription`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={statusText}
          >
            {ring}
          </span>
        ) : (
          <span className="sys-group-status">{ring}</span>
        )}
      </header>
      <div className="sys-group-body">
        {children ?? (
          <p className="sys-group-empty">No takes yet. Add audio to start.</p>
        )}
      </div>
      {handoff ? (
        <footer className="sys-group-footer">
          <StageHandoff
            {...handoff}
            size={48}
            variant={status === "done" ? "primary" : "secondary"}
          />
        </footer>
      ) : null}
    </section>
  );
}
