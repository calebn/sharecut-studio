import { type CSSProperties, type ReactNode, useId } from "react";
import type { MuteState } from "../utils/audio";
import { MUTE_STATE_ROW_CLASS } from "./muteRowClass";
import { TrackFaderView } from "./TrackFaderView";
import { TrackMuteSoloButtonsView } from "./TrackMuteSoloButtonsView";
import { SAVED_MUTE_READ_ONLY } from "./trackMuteCopy";

export type MixTrack = Readonly<{
  id: string;
  label: string;
  initials: string;
  identityColor: string;
  muteState: MuteState;
  solo: boolean;
  faderDb: number;
  stagingDb: number;
}>;
export type MixAccess =
  | { kind: "edit"; onVolume: (trackId: string, db: number) => void }
  | { kind: "listen"; onVolume?: never };
export type TrackMixViewProps =
  | { state: "loading" }
  | {
      state: "ready";
      rows: readonly MixTrack[];
      access: MixAccess;
      preview: "host" | "shared-full-mix";
      /** The Solo on chip, shown above the rows while any track is soloed. */
      soloStatus?: ReactNode;
      /** A track's plays-at line under its fader, from its base gain. */
      renderPlaysAt?: (trackId: string, baseDb: number) => ReactNode;
      onMute: (trackId: string) => void;
      onSolo: (trackId: string) => void;
    };

export function TrackMixView(props: TrackMixViewProps) {
  const noteId = useId();
  const mutedNoteId = useId();
  if (props.state === "loading") {
    return (
      <div className="track-mix" aria-busy="true" aria-label="Loading tracks">
        Loading tracks…
      </div>
    );
  }
  const { rows, access, preview, soloStatus, renderPlaysAt, onMute, onSolo } =
    props;
  return (
    <div className="track-mix" tabIndex={-1}>
      {soloStatus}
      <p className="track-mix-note" id={noteId}>
        {access.kind === "edit"
          ? "Volume and M are saved in the mix. S is for your listening and never exports."
          : "Only the host and editors can change volume. M and S are for your listening and never exports. A saved mute cannot be overridden."}
      </p>
      {access.kind !== "edit" &&
      rows.some((row) => row.muteState === "saved") ? (
        <p className="track-mix-note" id={mutedNoteId}>
          {`${SAVED_MUTE_READ_ONLY}.`}
        </p>
      ) : null}
      {preview === "shared-full-mix" ? (
        <p className="track-mix-note">
          Shared playback uses Full mix; listen controls may not be audible in
          this preview.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="track-mix-note">
          No tracks yet. Add or import audio from More.
        </p>
      ) : (
        <ul className="track-mix-list" aria-label="Track mix">
          {rows.map((row) => (
            <MixRow
              key={row.id}
              row={row}
              access={access}
              noteId={noteId}
              mutedNoteId={mutedNoteId}
              renderPlaysAt={renderPlaysAt}
              onMute={onMute}
              onSolo={onSolo}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MixRow({
  row,
  access,
  noteId,
  mutedNoteId,
  renderPlaysAt,
  onMute,
  onSolo,
}: {
  row: MixTrack;
  access: MixAccess;
  noteId: string;
  mutedNoteId: string;
  renderPlaysAt?: (trackId: string, baseDb: number) => ReactNode;
  onMute: (trackId: string) => void;
  onSolo: (trackId: string) => void;
}) {
  return (
    <li
      className={`track-mix-row${MUTE_STATE_ROW_CLASS[row.muteState]}`}
      style={{ "--track-identity-color": row.identityColor } as CSSProperties}
    >
      <span className="track-mix-identity" aria-hidden="true">
        {row.initials}
      </span>
      <span className="track-mix-name" title={row.label}>
        {row.label}
      </span>
      <TrackMuteSoloButtonsView
        trackId={row.id}
        trackLabel={row.label}
        muteState={row.muteState}
        solo={row.solo}
        editsMix={access.kind === "edit"}
        readOnlyNoteId={mutedNoteId}
        onMute={() => onMute(row.id)}
        onSolo={() => onSolo(row.id)}
      />
      <TrackFaderView
        trackLabel={row.label}
        noteId={noteId}
        savedDb={row.faderDb}
        presentation={{
          kind: "compact",
          stagingDb: row.stagingDb,
          playsAt: renderPlaysAt
            ? (baseDb) => renderPlaysAt(row.id, baseDb)
            : undefined,
        }}
        access={
          access.kind === "edit"
            ? { kind: "edit", onCommit: (db) => access.onVolume(row.id, db) }
            : { kind: "read-only" }
        }
      />
    </li>
  );
}
