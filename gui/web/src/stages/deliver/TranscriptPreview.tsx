import { PersonAvatar } from "../../system/Person";
import {
  type TranscriptPreview as Preview,
  previewFooter,
  transcriptClock,
} from "./transcriptLogic";

type Props = { preview: Preview };

/** The first turns of the edited episode, as the files will hold them. */
export function TranscriptPreview({ preview }: Props) {
  return (
    <div className="dv-tx-preview">
      <ul className="dv-tx-turns" aria-label="Transcript preview">
        {preview.shown.map((turn, i) => (
          <li key={`${turn.startSec}-${i}`} className="dv-tx-turn">
            <PersonAvatar
              person={{ name: turn.speaker, colorIndex: turn.colorIndex }}
              size={24}
            />
            <div className="dv-tx-turn-body">
              <p className="dv-tx-turn-head">
                <span className="dv-tx-speaker">{turn.speaker}</span>
                <span className="sys-mono dv-tx-time">
                  <span className="sr-only">, </span>
                  {transcriptClock(turn.startSec)}
                </span>
              </p>
              <p className="dv-tx-text" dir="auto">
                {turn.text}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="dv-note dv-tx-foot">{previewFooter(preview)}</p>
    </div>
  );
}
