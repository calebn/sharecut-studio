import {
  type CutSpeech,
  type CutSpeechTrack,
  cutSpeakers,
  firstSpeechSec,
  joinNames,
} from "../edit/cutSpeech";
import { Button, Dialog, InlineError } from "../ui";
import { formatRulerTime } from "../utils/time";

const QUOTED_WORDS_MAX = 8;

export interface CutSpeechDialogViewProps {
  speech: CutSpeech | null;
  /** False when the edit has no gap form (approving a suggestion). */
  canLeaveGap: boolean;
  busy: boolean;
  error: string | null;
  onCutAnyway: () => void;
  onLeaveGap: () => void;
  onClose: () => void;
}

function quoted(track: CutSpeechTrack): string {
  if (track.words.length === 0) return "speech not in the transcript";
  const words = track.words.slice(0, QUOTED_WORDS_MAX).map((w) => w.text);
  const more = track.words.length > QUOTED_WORDS_MAX ? "…" : "";
  return `“${words.join(" ")}${more}”`;
}

/** Store-free confirm for a ripple the host refused because it would cut other speech. */
export function CutSpeechDialogView({
  speech,
  canLeaveGap,
  busy,
  error,
  onCutAnyway,
  onLeaveGap,
  onClose,
}: CutSpeechDialogViewProps) {
  const names = speech ? joinNames(cutSpeakers(speech)) : "";
  const tracks = speech
    ? [...speech.tracks].sort((a, b) => firstSpeechSec(a) - firstSpeechSec(b))
    : [];
  return (
    <Dialog
      open={speech !== null}
      onClose={onClose}
      title={`Cut ${names}'s speech too?`}
      panelClassName="cut-speech-dialog-panel"
      closeDisabled={busy}
    >
      <p>Ripple edits keep speakers in sync, so this also cuts:</p>
      <ul className="cut-speech-dialog-list">
        {tracks.map((track) => (
          <li key={track.track_id}>
            <strong>{track.speaker}</strong> at{" "}
            {formatRulerTime(firstSpeechSec(track), 0.1)}: {quoted(track)}
          </li>
        ))}
      </ul>
      {canLeaveGap ? (
        <p>Leave a gap keeps their speech and leaves silence where you cut.</p>
      ) : null}
      <InlineError message={error} role="alert" />
      <div className="bounce-dialog-actions cut-speech-dialog-actions">
        {canLeaveGap ? (
          <Button disabled={busy} onClick={onLeaveGap}>
            Leave a gap
          </Button>
        ) : (
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        )}
        <Button variant="danger" disabled={busy} onClick={onCutAnyway}>
          Cut anyway
        </Button>
      </div>
    </Dialog>
  );
}
