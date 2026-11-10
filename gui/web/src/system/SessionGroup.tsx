import { type ReactNode, useRef, useState } from "react";
import { Button } from "../ui";
import { InlineEdit } from "./InlineEdit";
import { clampUnit, percentOf } from "./progress";
import { type PrepareTarget, SessionTargetChip } from "./SessionTargetChip";
import { StageHandoff, type StageHandoffProps } from "./StageHandoff";
import { StatusGlyph } from "./StatusGlyph";

type SessionGroupStatus = "idle" | "new" | "running" | "done" | "failed";

export type SessionGroupProps = {
  title: string;
  /** Heading level of the title; 3 under a stage's h2 (Prepare), 2 when the group is a top section. */
  headingLevel?: 2 | 3;
  people: number;
  takes: number;
  /** "14:20". */
  duration: string;
  /** Omit when the group has no target times to show; the chip goes. */
  target?: PrepareTarget;
  targetLocked?: boolean;
  onTarget?: (target: PrepareTarget) => void;
  /** Names the session in the target control so two sessions differ. */
  targetFor?: string;
  /** Omit when the group has no transcription state to show; the ring goes. */
  status?: SessionGroupStatus;
  /** 0 to 1 while running. */
  progress?: number;
  /** The takes. Empty groups say so. */
  children?: ReactNode;
  /** Saves the group's name; an empty name clears it. A Rename button beside the title opens the field. */
  onRename?: (name: string) => void;
  /** The name `onRename` edits, empty when none is set. */
  name?: string;
  nameMaxLength?: number;
  /** Shuts Rename and says why. */
  renameDisabledReason?: string;
  /** Defaults to primary once `status` is done, else secondary. */
  handoffVariant?: "secondary" | "primary";
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
  headingLevel = 3,
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
  onRename,
  name = "",
  nameMaxLength,
  renameDisabledReason,
  handoffVariant,
  handoff,
}: SessionGroupProps) {
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const percent = percentOf(progress);
  const statusText =
    status === "running"
      ? `Transcribing, ${percent}%`
      : status === "done"
        ? "Transcribed"
        : status === "failed"
          ? "Transcription failed"
          : status === "new"
            ? "New audio waiting"
            : "Not started";
  const ring =
    status === undefined ? null : (
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
        <Heading className="sys-group-title">{title}</Heading>
        {onRename && !renaming ? (
          <Button
            ref={renameButton}
            aria-label="Rename session"
            disabledReason={renameDisabledReason}
            onClick={() => setRenaming(true)}
          >
            Rename
          </Button>
        ) : null}
        {onRename && renaming ? (
          <InlineEdit
            focusOnMount
            className="sys-group-rename"
            label="Session name"
            maxLength={nameMaxLength}
            placeholder="Session name"
            value={name}
            onCommit={onRename}
            onEnd={(how) => {
              setRenaming(false);
              if (how !== "blur") {
                queueMicrotask(() => renameButton.current?.focus());
              }
            }}
          />
        ) : null}
        <p className="sys-group-stats">
          {[
            plural(people, "person", "people"),
            plural(takes, "take", "takes"),
            duration,
          ].join(" · ")}
        </p>
        {target ? (
          <SessionTargetChip
            target={target}
            locked={targetLocked}
            onTarget={onTarget}
            session={targetFor}
          />
        ) : null}
        {status === undefined ? null : status === "running" ? (
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
            variant={
              handoffVariant ?? (status === "done" ? "primary" : "secondary")
            }
          />
        </footer>
      ) : null}
    </section>
  );
}
