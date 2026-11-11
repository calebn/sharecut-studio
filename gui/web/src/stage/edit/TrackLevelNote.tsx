import { SAVED_MUTE_READ_ONLY } from "../../tracks/trackMuteCopy";
import { useVolumeEnvelopeDb } from "../../tracks/useVolumeEnvelopeDb";
import type { TrackView } from "../../types/project";
import {
  formatGainDb,
  trackFaderDb,
  trackOutputGainDb,
} from "../../utils/audio";

export function TrackLevelNote({
  track,
  editable,
  muteNoteId,
}: {
  track: TrackView;
  editable: boolean;
  muteNoteId?: string;
}) {
  const envelopeDb = useVolumeEnvelopeDb(track.id);
  const fader = trackFaderDb(track);
  const balance = track.role === "dialogue" ? track : null;
  return (
    <>
      <p className="sys-inspector-note">
        {editable ? "" : "Only the host and editors can change the volume. "}
        Staging gain {formatGainDb(track.gain_db)}; plays at{" "}
        {formatGainDb(
          trackOutputGainDb({ gain_db: track.gain_db, fader_db: fader }) +
            (envelopeDb ?? 0),
        )}
        {envelopeDb === undefined
          ? ""
          : ` with the volume envelope at ${formatGainDb(envelopeDb)} at the playhead`}
      </p>
      {!editable && track.muted ? (
        <p className="sys-inspector-note" id={muteNoteId}>
          {`${SAVED_MUTE_READ_ONLY}.`}
        </p>
      ) : null}
      {balance ? (
        <p className="sys-inspector-note">
          Balance{" "}
          {balance.balance_stale == null
            ? "not measured"
            : balance.balance_stale
              ? "stale"
              : "current"}
          {balance.balance_measured_lufs == null
            ? ""
            : ` · ${balance.balance_measured_lufs.toFixed(1)} LUFS${balance.balance_ungated ? " · ungated" : ""}`}
        </p>
      ) : null}
    </>
  );
}
