import type { ReactNode, Ref } from "react";
import type { RecordSessionSummary } from "../../record";
import type { ShellBreakpoint } from "../../state/types";
import { RoomView, type RoomViewProps } from "../../system/RoomView";
import { Button } from "../../ui";
import type { LoadFailure } from "../frame/LoadFailureBanner";
import {
  EndedSessionCard,
  type EndedSessionCardProps,
} from "./EndedSessionCard";
import { HostBody } from "./HostBody";
import type { HostState } from "./hostModels";

export type RecordNotice = {
  text: string;
  action?: { label: string; onClick: () => void };
};

export type RecordLookup = "checking" | "none" | "found" | "failed";

export type RecordStageViewProps = {
  shell: ShellBreakpoint;
  state: HostState;
  failure?: LoadFailure | null;
  lookup: RecordLookup;
  busy: boolean;
  hydrateError: string | null;
  transportError: string | null;
  room: RoomViewProps | null;
  lastSession?: RecordSessionSummary | null;
  trackNames?: ReadonlyMap<string, string>;
  tracks?: EndedSessionCardProps["tracks"];
  movable?: EndedSessionCardProps["movable"];
  remapBusy?: boolean;
  onRemap?: EndedSessionCardProps["onRemap"];
  onNewTrack?: EndedSessionCardProps["onNewTrack"];
  onEdit?: EndedSessionCardProps["onEdit"];
  onRename?: EndedSessionCardProps["onRename"];
  hasClips?: boolean;
  notices: readonly RecordNotice[];
  storage?: ReactNode;
  more?: ReactNode;
  scrollRef?: Ref<HTMLDivElement>;
  onCreateRoom: () => void;
  onCheckAgain: () => void;
};

const NO_TRACK_NAMES: ReadonlyMap<string, string> = new Map();

function createLabel(last: RecordSessionSummary | null | undefined): string {
  return last?.number == null
    ? "Create record room"
    : `Start Session ${last.number + 1}`;
}

function EmptyRoom({
  lookup,
  lastSession,
  trackNames,
  tracks,
  movable,
  remapBusy,
  onRemap,
  onNewTrack,
  onEdit,
  onRename,
  hasClips,
  busy,
  hydrateError,
  transportError,
  onCreateRoom,
  onCheckAgain,
}: Pick<
  RecordStageViewProps,
  | "lookup"
  | "lastSession"
  | "trackNames"
  | "tracks"
  | "movable"
  | "remapBusy"
  | "onRemap"
  | "onNewTrack"
  | "onEdit"
  | "onRename"
  | "hasClips"
  | "busy"
  | "hydrateError"
  | "transportError"
  | "onCreateRoom"
  | "onCheckAgain"
>) {
  const failure = transportError ? (
    <p className="stage-host-note" role="status">
      {transportError}
    </p>
  ) : null;
  if (lookup === "none") {
    return (
      <>
        {lastSession ? (
          <EndedSessionCard
            session={lastSession}
            trackNames={trackNames ?? NO_TRACK_NAMES}
            tracks={tracks}
            movable={movable}
            busy={remapBusy}
            onRemap={onRemap}
            onNewTrack={onNewTrack}
            onEdit={onEdit}
            onRename={onRename}
            hasClips={hasClips}
          />
        ) : null}
        <section
          className="stage-host-section stage-host-record-empty"
          aria-labelledby="record-room"
        >
          <h2 id="record-room" className="stage-host-title">
            No record room yet
          </h2>
          <p className="stage-host-note">
            Creating one copies a guest link you can send.
          </p>
          {failure}
          <div className="stage-host-actions">
            <Button
              variant="primary"
              aria-disabled={busy || undefined}
              onClick={onCreateRoom}
            >
              {createLabel(lastSession)}
            </Button>
          </div>
        </section>
      </>
    );
  }
  if (lookup === "failed") {
    return (
      <section
        className="stage-host-section stage-host-record-empty"
        aria-labelledby="record-room"
      >
        <h2 id="record-room" className="stage-host-title">
          Could not look up the record room
        </h2>
        {hydrateError ? (
          <p className="stage-host-note" role="status">
            {hydrateError}
          </p>
        ) : null}
        {failure}
        <div className="stage-host-actions">
          <Button aria-disabled={busy || undefined} onClick={onCheckAgain}>
            Check again
          </Button>
        </div>
      </section>
    );
  }
  return (
    <div className="stage-host-record-empty">
      <p className="stage-host-note" role="status">
        Looking for a record room…
      </p>
      {failure}
    </div>
  );
}

export function RecordStageView({
  shell,
  state,
  failure,
  lookup,
  busy,
  hydrateError,
  transportError,
  room,
  lastSession,
  trackNames,
  tracks,
  movable,
  remapBusy,
  onRemap,
  onNewTrack,
  onEdit,
  onRename,
  hasClips,
  notices,
  storage,
  more,
  scrollRef,
  onCreateRoom,
  onCheckAgain,
}: RecordStageViewProps) {
  return (
    <HostBody
      stage="record"
      shell={shell}
      state={state}
      failure={failure}
      scrollRef={scrollRef}
    >
      {room ? (
        <>
          <div className="stage-host-record-notices" aria-live="polite">
            {notices.map(({ text, action }) => (
              <p key={text} className="stage-host-note">
                {text}
                {action ? (
                  <Button onClick={action.onClick}>{action.label}</Button>
                ) : null}
              </p>
            ))}
            {storage}
          </div>
          <RoomView {...room} embedded />
          {more}
        </>
      ) : (
        <EmptyRoom
          lookup={lookup}
          lastSession={lastSession}
          trackNames={trackNames}
          tracks={tracks}
          movable={movable}
          remapBusy={remapBusy}
          onRemap={onRemap}
          onNewTrack={onNewTrack}
          onEdit={onEdit}
          onRename={onRename}
          hasClips={hasClips}
          busy={busy}
          hydrateError={hydrateError}
          transportError={transportError}
          onCreateRoom={onCreateRoom}
          onCheckAgain={onCheckAgain}
        />
      )}
    </HostBody>
  );
}
