import { type CSSProperties, type ReactNode, useState } from "react";
import { BrandLockup } from "../ui";
import { NotesRail } from "./NotesRail";
import type { NoteDraft, NoteItem } from "./notesRailModel";
import { RecordDock, type RecordDockProps } from "./RecordDock";
import { RoomAlert } from "./RoomAlert";
import { RoomStatusPill } from "./RoomStatusPill";
import { ListenerAvatar, ListenerRow, RoomTile } from "./RoomTile";
import type { RoomAlertInput } from "./roomAlertModel";
import { clockText, type RoomPhase } from "./roomPhase";
import {
  type RoomPerson,
  type RoomRole,
  roomViewModel,
  type ViewerWidth,
} from "./roomViewModel";

/** The phase's identity for the time chip: a new take or state is a new key. */
function phaseKey(phase: RoomPhase): string {
  return phase.kind === "live" ? `live-${phase.take}` : phase.kind;
}

export type RoomViewProps = {
  seat: RoomRole;
  /** The session title, printed in the header and the one h1 of the page. */
  title: string;
  people: RoomPerson[];
  phase: RoomPhase;
  viewerWidth?: ViewerWidth;
  alerts?: RoomAlertInput[];
  /** Whether the Notes rail starts open. The Notes button flips it after that. */
  defaultNotesOpen?: boolean;
  notes: NoteItem[];
  /** The viewer's own name, so a guest keeps their own notes. */
  selfName: string;
  onSendNote: (note: NoteDraft) => void;
  unreadNotes?: number;
  onInvite?: () => void;
  muted?: boolean;
  /** Host only: the Record button's face and handlers. */
  record?: RecordDockProps["record"];
  /** Replaces the secondaries after Stop, as the dock does. */
  status?: ReactNode;
  leaveDisabledReason?: string;
  onMute?: () => void;
  onComment?: () => void;
  onPause?: () => void;
  onMore?: () => void;
  onLeave?: () => void;
};

/**
 * The one Room surface for every seat. The header, the alert slot, the tile
 * grid with its listener row and the dock form a fixed-height column; the
 * Notes rail sits beside the grid on the desktop. Presentational: the caller
 * owns people, phase and the notes list; the composer's draft is local.
 */
export function RoomView({
  seat,
  title,
  people,
  phase,
  viewerWidth = "desktop",
  alerts,
  defaultNotesOpen,
  notes,
  selfName,
  onSendNote,
  unreadNotes = 0,
  onInvite,
  muted = false,
  record,
  status,
  leaveDisabledReason,
  onMute,
  onComment,
  onPause,
  onMore,
  onLeave,
}: RoomViewProps) {
  const [notesChoice, setNotesChoice] = useState<boolean | undefined>(
    defaultNotesOpen,
  );
  const [draft, setDraft] = useState("");
  const [everyone, setEveryone] = useState(false);
  // The chip pins the live clock; clearing it makes the next note a session note.
  const [timeCleared, setTimeCleared] = useState<string | null>(null);
  const model = roomViewModel({
    role: seat,
    people,
    phase,
    viewerWidth,
    notesOpen: notesChoice,
    alerts,
    invite: onInvite !== undefined,
  });
  const pinned =
    phase.kind === "live" || phase.kind === "paused"
      ? clockText(phase.clockSec)
      : null;
  // Clearing holds until the phase changes (a new take, a pause, a save) or the
  // note is sent, so a cleared chip never comes back on its own mid-take.
  const draftTime = timeCleared === phaseKey(phase) ? null : pinned;
  const paused = phase.kind === "paused";

  return (
    <div className="sys-room-view" data-seat={seat} data-width={viewerWidth}>
      <header className="sys-room-view-header">
        <BrandLockup name="ShareCut" className="sys-room-view-wordmark" />
        <h1 className="sys-room-view-title">{title}</h1>
        <RoomStatusPill phase={phase} />
      </header>
      <div className="sys-room-view-body">
        <main className="sys-room-view-stage">
          <div className="sys-room-view-alert">
            <RoomAlert alerts={model.alerts} />
          </div>
          <div
            className="sys-room-view-grid"
            style={
              { "--sys-room-view-columns": model.columns } as CSSProperties
            }
          >
            {model.tiles.map((tile) =>
              tile.kind === "invite" && onInvite ? (
                <RoomTile
                  key={tile.key}
                  presence="placeholder"
                  onInvite={onInvite}
                />
              ) : tile.kind === "invite" ? null : (
                <RoomTile key={tile.key} {...tile.props} />
              ),
            )}
          </div>
          {model.listeners.length > 0 ? (
            <ListenerRow>
              {model.listeners.map((listener) => (
                <ListenerAvatar
                  key={listener.key}
                  person={listener.person}
                  label={listener.label}
                />
              ))}
            </ListenerRow>
          ) : null}
        </main>
        {model.railOpen ? (
          <aside className="sys-room-view-rail">
            <NotesRail
              items={notes}
              viewer={seat}
              selfName={selfName}
              draft={draft}
              onDraftChange={setDraft}
              draftTime={draftTime}
              onClearTime={() => setTimeCleared(phaseKey(phase))}
              everyone={everyone}
              onEveryoneChange={seat === "guest" ? undefined : setEveryone}
              onSend={(note) => {
                onSendNote(note);
                setDraft("");
                setTimeCleared(null);
              }}
              paused={paused}
            />
          </aside>
        ) : null}
      </div>
      <footer className="sys-room-view-dock">
        <RecordDock
          seat={model.dockSeat}
          record={record}
          muted={muted}
          showComment={model.showComment}
          unreadNotes={unreadNotes}
          notesOpen={model.railOpen}
          status={status}
          leaveDisabledReason={leaveDisabledReason}
          onMute={onMute}
          onComment={onComment}
          onPause={onPause}
          onNotes={() => setNotesChoice(!model.railOpen)}
          onMore={onMore}
          onLeave={onLeave}
        />
      </footer>
    </div>
  );
}
