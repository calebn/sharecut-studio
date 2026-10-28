import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useState,
} from "react";
import { BrandLockup } from "../ui";
import type { DrawerDetent } from "../ui/BottomSheet";
import { DeclinedScrim } from "./DeclinedScrim";
import { NotesRail } from "./NotesRail";
import type { NoteDraft, NoteItem } from "./notesRailModel";
import { RecordDock } from "./RecordDock";
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
import { Sheet } from "./Sheet";
import { SystemIcon } from "./SystemIcon";

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
  onStartTake?: () => void;
  onStopTake?: () => void;
  recordBusy?: boolean;
  status?: ReactNode;
  leaveDisabledReason?: string;
  onMute?: () => void;
  onComment?: () => void;
  onPause?: () => void;
  onMore?: () => void;
  onLeave?: () => void;
  /**
   * The viewer declined to be recorded: the room dims behind a peek bar with
   * Join recording, and the rest of the room goes inert.
   */
  declined?: { onJoin: () => void };
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
  onStartTake,
  onStopTake,
  recordBusy = false,
  status,
  leaveDisabledReason,
  onMute,
  onComment,
  onPause,
  onMore,
  onLeave,
  declined,
}: RoomViewProps) {
  const [notesChoice, setNotesChoice] = useState<boolean | undefined>(
    defaultNotesOpen,
  );
  const [draft, setDraft] = useState("");
  const [everyone, setEveryone] = useState(false);
  const [detent, setDetent] = useState<DrawerDetent>("half");
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
    canRecord: onStartTake !== undefined && onStopTake !== undefined,
    notes,
    selfName,
  });
  const pinned =
    phase.kind === "live" || phase.kind === "paused"
      ? clockText(phase.clockSec)
      : null;
  // Clearing holds until the phase changes (a new take, a pause, a save) or the
  // note is sent, so a cleared chip never comes back on its own mid-take.
  const draftTime = timeCleared === phaseKey(phase) ? null : pinned;
  const paused = phase.kind === "paused";

  const closeSheet = useCallback(() => setNotesChoice(false), []);
  const rail = (
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
  );
  const dockStatus = status ?? model.dockStatus ?? undefined;
  const leaveReason =
    leaveDisabledReason ??
    (seat === "guest" && phase.kind === "saving"
      ? "Your recording is still saving"
      : undefined);

  return (
    <div
      className="sys-room-view"
      data-seat={seat}
      data-width={viewerWidth}
      data-declined={declined ? "" : undefined}
    >
      <header className="sys-room-view-header">
        <BrandLockup name="ShareCut" className="sys-room-view-wordmark" />
        <h1 className="sys-room-view-title">{title}</h1>
        <RoomStatusPill phase={phase} />
      </header>
      <div className="sys-room-view-body" inert={declined ? true : undefined}>
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
          <aside className="sys-room-view-rail">{rail}</aside>
        ) : null}
      </div>
      {viewerWidth === "phone" ? (
        <button
          type="button"
          className="sys-room-view-peek"
          inert={declined ? true : undefined}
          aria-haspopup="dialog"
          aria-expanded={model.sheetOpen}
          onClick={() => setNotesChoice(true)}
        >
          <SystemIcon name="chevron-up" size={16} />
          <span className="sys-room-view-peek-label">Notes</span>
          <span className="sys-room-view-peek-text">
            {model.peek
              ? `${model.peek.author}: ${model.peek.text}`
              : "No notes yet"}
          </span>
          {model.peek?.time ? (
            <span className="sys-mono sys-room-view-peek-time">
              {model.peek.time}
            </span>
          ) : null}
        </button>
      ) : null}
      <footer
        className="sys-room-view-dock"
        inert={declined ? true : undefined}
      >
        <RecordDock
          seat={model.dockSeat}
          record={
            model.record && onStartTake && onStopTake
              ? {
                  ...model.record,
                  busy: recordBusy,
                  onStart: onStartTake,
                  onStop: onStopTake,
                }
              : undefined
          }
          muted={muted}
          showComment={model.showComment}
          unreadNotes={unreadNotes}
          notesOpen={model.notesOpen}
          status={dockStatus}
          leaveDisabledReason={leaveReason}
          onMute={onMute}
          onComment={onComment}
          onPause={onPause}
          onNotes={() => setNotesChoice(!model.notesOpen)}
          onMore={onMore}
          onLeave={onLeave}
        />
      </footer>
      {declined ? (
        <DeclinedScrim phase={phase} onJoin={declined.onJoin} />
      ) : null}
      {viewerWidth === "desktop" ? null : (
        <Sheet
          form="bottom"
          title="Notes"
          open={model.sheetOpen}
          onClose={closeSheet}
          detent={detent}
          onDetentChange={setDetent}
        >
          {rail}
        </Sheet>
      )}
    </div>
  );
}
