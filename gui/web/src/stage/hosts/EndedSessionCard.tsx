import { useRef, useState } from "react";
import type { RecordSessionSummary } from "../../record";
import { InlineEdit } from "../../system/InlineEdit";
import {
  Button,
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  ToggleButton,
} from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";

const DATE = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
});

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The longest session name the server keeps. */
const SESSION_NAME_MAX = 80;

function heading({
  number,
  name: given,
  ended_at,
}: RecordSessionSummary): string {
  if (given) {
    return given;
  }
  const name = number === null ? "Last session" : `Session ${number}`;
  const when = ended_at ? new Date(ended_at) : null;
  return when && !Number.isNaN(when.getTime())
    ? `${name} · ${DATE.format(when)}`
    : name;
}

function takesLine({ takes }: RecordSessionSummary): string {
  if (takes.length === 0) {
    return "No takes";
  }
  const total = takes.reduce((sum, t) => sum + t.recording_ms, 0);
  return `${takes.length} ${takes.length === 1 ? "take" : "takes"} · ${clock(total)}`;
}

export type EndedSessionCardProps = {
  session: RecordSessionSummary;
  trackNames: ReadonlyMap<string, string>;
  /** The project's tracks, offered by each participant's change menu. */
  tracks?: readonly { id: string; label: string }[];
  /** Participants whose clips were found on the timeline; only they get a menu. */
  movable?: ReadonlySet<string>;
  /** A track change is in flight: the menus stay shut. */
  busy?: boolean;
  onRemap?: (participantId: string, trackId: string) => void;
  /** Offers "New track" at the foot of each menu; works with a single project track. */
  onNewTrack?: (participantId: string) => void;
  /** Edit hand-off; the primary button shows only for a landed session with clips on the timeline. */
  onEdit?: () => void;
  hasClips?: boolean;
  /** Saves the session's name; an empty name clears it. Offered for a landed, numbered session only. */
  onRename?: (name: string) => void;
};

const NO_TRACKS: readonly { id: string; label: string }[] = [];

function TrackMenu({
  name,
  current,
  target,
  tracks,
  busy,
  onPick,
  onNewTrack,
}: {
  name: string;
  current: string | null;
  target: string;
  tracks: readonly { id: string; label: string }[];
  busy: boolean;
  onPick: (trackId: string) => void;
  onNewTrack?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={`Track for ${name}`}
      className="ui-menu-root stage-host-track-menu"
      trigger={(props) => (
        <Button
          {...props}
          aria-label={`Track for ${name}: ${target}`}
          aria-busy={busy || undefined}
          disabledReason={busy ? BUSY_REASON : undefined}
        >
          {target}
        </Button>
      )}
    >
      <MenuSection label="Move to track">
        {tracks.map((track) => (
          <ToggleButton
            key={track.id}
            quiet
            role="menuitemradio"
            tabIndex={-1}
            pressed={track.id === current}
            aria-checked={track.id === current}
            onClick={() => {
              setOpen(false);
              if (track.id !== current) {
                onPick(track.id);
              }
            }}
          >
            {track.label}
          </ToggleButton>
        ))}
        {onNewTrack ? (
          <>
            <MenuSeparator />
            <MenuItem
              onSelect={() => {
                setOpen(false);
                onNewTrack();
              }}
            >
              New track
            </MenuItem>
          </>
        ) : null}
      </MenuSection>
    </Menu>
  );
}

export function EndedSessionCard({
  session,
  trackNames,
  tracks = NO_TRACKS,
  movable,
  busy = false,
  onRemap,
  onNewTrack,
  onEdit,
  hasClips = false,
  onRename,
}: EndedSessionCardProps) {
  const [renaming, setRenaming] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const canRename = session.landed && session.number !== null && !!onRename;
  return (
    <section
      className="stage-host-section stage-host-record-empty"
      aria-labelledby="record-last-session"
    >
      <div className="stage-host-title-row">
        <h2 id="record-last-session" className="stage-host-title">
          {heading(session)}
        </h2>
        {canRename && !renaming ? (
          <Button
            ref={renameButton}
            aria-label="Rename session"
            disabledReason={busy ? BUSY_REASON : undefined}
            onClick={() => setRenaming(true)}
          >
            Rename
          </Button>
        ) : null}
      </div>
      {canRename && renaming ? (
        <InlineEdit
          focusOnMount
          className="stage-host-rename"
          label="Session name"
          maxLength={SESSION_NAME_MAX}
          placeholder="Session name"
          value={session.name ?? ""}
          onCommit={(name) => onRename?.(name)}
          onEnd={(how) => {
            setRenaming(false);
            if (how !== "blur") {
              // The button mounts after this update; focus it then.
              queueMicrotask(() => renameButton.current?.focus());
            }
          }}
        />
      ) : null}
      <p className="stage-host-note">{takesLine(session)}</p>
      <ul className="stage-host-list">
        {session.participants.map((p) => {
          const name = p.display_name.trim() || "Guest";
          const several =
            session.landed &&
            p.track_id === null &&
            !!movable?.has(p.participant_id);
          const target = !session.landed
            ? null
            : several
              ? "Several tracks"
              : p.track_id === null
                ? "New track"
                : (trackNames.get(p.track_id) ?? "Track removed");
          const menu =
            target !== null &&
            !!onRemap &&
            (tracks.length > 1 || !!onNewTrack) &&
            movable?.has(p.participant_id);
          return (
            <li key={p.participant_id} className="stage-host-note">
              {name}
              {target === null ? null : (
                <>
                  {" "}
                  <span aria-hidden="true">→</span>
                  <span className="sr-only"> to</span>{" "}
                  {menu ? (
                    <TrackMenu
                      name={name}
                      current={p.track_id}
                      target={target}
                      tracks={tracks}
                      busy={busy}
                      onPick={(trackId) => onRemap?.(p.participant_id, trackId)}
                      onNewTrack={
                        onNewTrack
                          ? () => onNewTrack(p.participant_id)
                          : undefined
                      }
                    />
                  ) : (
                    target
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {session.landed && hasClips && onEdit ? (
        <div className="stage-host-actions">
          <Button variant="primary" onClick={onEdit}>
            {session.number === null
              ? "Edit session"
              : `Edit Session ${session.number}`}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
