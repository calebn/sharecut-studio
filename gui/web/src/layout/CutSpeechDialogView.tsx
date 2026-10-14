import {
  type CutSpeech,
  type CutSpeechTrack,
  cutSpeakers,
  firstSpeechSec,
  joinNames,
} from "../edit/cutSpeech";
import { Button, Dialog, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
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

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : noun.endsWith("ch") ? "es" : "s"}`;
}

function quoted(track: CutSpeechTrack): string {
  const sounds = track.sound_spans.length;
  if (track.words.length === 0)
    return sounds > 1
      ? `${plural(sounds, "stretch")} of speech-level sound with no transcript words`
      : "speech not in the transcript";
  const words = track.words.slice(0, QUOTED_WORDS_MAX).map((w) => w.text);
  const more = track.words.length > QUOTED_WORDS_MAX ? "…" : "";
  const extra =
    sounds > 0 ? ` and ${plural(sounds, "sound-only stretch")}` : "";
  return `“${words.join(" ")}${more}”${extra}`;
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
      phoneSheet
      footer={
        <div className="bounce-dialog-actions cut-speech-dialog-actions">
          {canLeaveGap ? (
            <Button
              disabledReason={busy ? BUSY_REASON : undefined}
              onClick={onLeaveGap}
            >
              Leave a gap
            </Button>
          ) : (
            <Button
              disabledReason={busy ? BUSY_REASON : undefined}
              onClick={onClose}
            >
              Cancel
            </Button>
          )}
          <Button
            variant="danger"
            disabledReason={busy ? BUSY_REASON : undefined}
            onClick={onCutAnyway}
          >
            Cut anyway
          </Button>
        </div>
      }
    >
      <p>
        {speech && speech.spans.length > 1
          ? `Ripple edits keep speakers in sync, so these ${speech.spans.length} cuts also cut:`
          : "Ripple edits keep speakers in sync, so this also cuts:"}
      </p>
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
      <InlineError message={error} />
    </Dialog>
  );
}
