import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui";
import { HINT_MS, RecordButton, type RecordButtonProps } from "./RecordButton";
import { SystemIcon } from "./SystemIcon";
import { VerbButton } from "./VerbButton";
import { hintOf, verbOf } from "./verbDisplay";

export type DockSeat = "host" | "guest" | "producer";

export type RecordDockProps = {
  seat: DockSeat;
  /** Host only: the Record button's face and handlers. */
  record?: Pick<
    RecordButtonProps,
    "face" | "busy" | "disabledReason" | "onStart" | "onStop"
  >;
  muted?: boolean;
  /** Comment is hidden until a take is live; a waiting room has nothing to mark. */
  showComment?: boolean;
  /** Unread notes, shown as a count on the Notes button. */
  unreadNotes?: number;
  notesOpen?: boolean;
  /** Replaces the secondaries after Stop: "Saving · 64% · keep this page open". */
  status?: ReactNode;
  /** With `status`: a Done primary in the far slot in place of Leave. Ignored without `status`. */
  onDone?: () => void;
  /** Holds Leave: it stays pressable (aria-disabled) and a press shows this reason briefly. */
  leaveDisabledReason?: string;
  onMute?: () => void;
  onComment?: () => void;
  onPause?: () => void;
  /** Host only: Stop beside Resume while a take is paused. */
  onStop?: () => void;
  onNotes?: () => void;
  onMore?: () => void;
  onLeave?: () => void;
};

/**
 * The Record stage's Action bar in its transport form: centred round buttons, 48 px
 * secondaries around one 64 px primary, 16 px apart. Leave or More sits 24 px away at
 * the far right, pulled closer under 40rem. The primary is Record for the host, Mute
 * for a guest and Comment for a producer, so the most frequent act is always under
 * the thumb.
 */
export function RecordDock({
  seat,
  record,
  muted = false,
  showComment = true,
  unreadNotes = 0,
  notesOpen = false,
  status,
  onDone,
  leaveDisabledReason,
  onMute,
  onComment,
  onPause,
  onStop,
  onNotes,
  onMore,
  onLeave,
}: RecordDockProps) {
  const [hinting, setHinting] = useState(false);
  const hintTimer = useRef<number | undefined>(undefined);
  const hintId = useId();
  useEffect(() => () => window.clearTimeout(hintTimer.current), []);
  const pressHeldLeave = () => {
    setHinting(true);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHinting(false), HINT_MS);
  };
  const mute = (
    <button
      type="button"
      className={`sys-dock-btn${seat === "guest" ? " sys-dock-btn--primary" : ""}`}
      aria-label={muted ? "Unmute" : "Mute"}
      title={`${muted ? "Unmute" : "Mute"}${hintOf(verbOf("mute"))}`}
      onClick={onMute}
    >
      <SystemIcon
        name={muted ? "mic-off" : "mic"}
        size={seat === "guest" ? 24 : 20}
      />
    </button>
  );
  const comment = showComment ? (
    <VerbButton
      verb="comment"
      className={
        seat === "producer"
          ? "sys-dock-btn sys-dock-btn--primary"
          : "sys-dock-btn"
      }
      size={seat === "producer" ? 24 : 20}
      onClick={onComment}
    />
  ) : null;
  const notes = (
    <button
      type="button"
      className="sys-dock-btn sys-dock-notes"
      aria-label={unreadNotes > 0 ? `Notes, ${unreadNotes} unread` : "Notes"}
      aria-pressed={notesOpen}
      title="Notes"
      onClick={onNotes}
    >
      <SystemIcon name="panel-right" size={20} />
      {unreadNotes > 0 ? (
        <span className="sys-dock-badge" aria-hidden="true">
          {unreadNotes}
        </span>
      ) : null}
    </button>
  );

  let center: ReactNode;
  if (status !== undefined) {
    center = (
      <>
        <div className="sys-dock-status">{status}</div>
        {/* A saved guest keeps Notes: the Takes tray with their clipping summary opens from it. */}
        {onDone && seat !== "host" ? notes : null}
      </>
    );
  } else if (seat === "host") {
    // The host dock is whole without a record prop; only the Record button and
    // its Pause depend on it.
    center = (
      <>
        {mute}
        {comment}
        {record ? <RecordButton {...record} /> : null}
        {record?.face === "live" ? (
          <VerbButton
            verb="pauseTake"
            className="sys-dock-btn"
            size={20}
            onClick={onPause}
          />
        ) : null}
        {record?.face === "paused" ? (
          <VerbButton
            verb="stopTake"
            className="sys-dock-btn"
            size={20}
            disabled={record.busy}
            onClick={onStop}
          />
        ) : null}
        {notes}
      </>
    );
  } else if (seat === "guest") {
    center = (
      <>
        {mute}
        {comment}
        {notes}
      </>
    );
  } else {
    center = (
      <>
        {comment}
        {notes}
      </>
    );
  }

  return (
    <div
      className="sys-dock"
      data-seat={seat}
      role="group"
      aria-label="Recording controls"
    >
      <div className="sys-dock-center">{center}</div>
      <div className="sys-dock-far">
        {seat === "host" ? (
          <VerbButton
            verb="more"
            className="sys-dock-btn"
            size={20}
            onClick={onMore}
          />
        ) : onDone && status !== undefined ? (
          <Button variant="primary" className="sys-dock-done" onClick={onDone}>
            Done
          </Button>
        ) : (
          <>
            <button
              type="button"
              className="sys-dock-btn"
              aria-label="Leave room"
              title={leaveDisabledReason ?? "Leave room"}
              aria-disabled={leaveDisabledReason ? true : undefined}
              aria-describedby={leaveDisabledReason ? hintId : undefined}
              onClick={leaveDisabledReason ? pressHeldLeave : onLeave}
            >
              <SystemIcon name="door-open" size={20} />
            </button>
            {leaveDisabledReason ? (
              <span
                id={hintId}
                className="sys-dock-hint"
                role="status"
                data-shown={hinting || undefined}
              >
                {hinting ? leaveDisabledReason : null}
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
