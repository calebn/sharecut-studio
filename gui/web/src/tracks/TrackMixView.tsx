import { type CSSProperties, type ReactNode, useId } from "react";
import type { MuteState } from "../utils/audio";
import { MUTE_STATE_ROW_CLASS } from "./muteRowClass";
import { TrackFaderView } from "./TrackFaderView";
import { TrackMuteSoloButtonsView } from "./TrackMuteSoloButtonsView";

export type MixTrack = Readonly<{
  id: string;
  label: string;
  initials: string;
  identityColor: string;
  muteState: MuteState;
  solo: boolean;
  faderDb: number;
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
      onMute: (trackId: string) => void;
      onSolo: (trackId: string) => void;
    };

export function TrackMixView(props: TrackMixViewProps) {
  const descriptionId = useId();
  if (props.state === "loading") {
    return (
      <div className="track-mix" aria-busy="true" aria-label="Loading tracks">
        Loading tracks…
      </div>
    );
  }
  const { rows, access, preview, soloStatus, onMute, onSolo } = props;
  return (
    <div className="track-mix">
      {soloStatus}
      <p id={descriptionId} className="track-mix-note">
        {access.kind === "edit"
          ? "Volume and M are saved in the mix. S is for your listening and never exports."
          : "Only the host and editors can change volume. M and S are for your listening and never exports. A saved mute cannot be overridden."}
      </p>
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
              descriptionId={descriptionId}
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
  descriptionId,
  onMute,
  onSolo,
}: {
  row: MixTrack;
  access: MixAccess;
  descriptionId: string;
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
        onMute={() => onMute(row.id)}
        onSolo={() => onSolo(row.id)}
      />
      <TrackFaderView
        trackLabel={row.label}
        savedDb={row.faderDb}
        presentation={{ kind: "compact", descriptionId }}
        access={
          access.kind === "edit"
            ? { kind: "edit", onCommit: (db) => access.onVolume(row.id, db) }
            : { kind: "read-only" }
        }
      />
    </li>
  );
}
