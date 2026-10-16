import { useId } from "react";
import { runPointerCommand } from "../commands/pointer";
import { seekTransport } from "../commands/seek";
import { Button } from "../ui";
import {
  isSoundAction,
  SOUND_ACTION_LABEL,
  SOUND_ACTIONS,
  type SuggestedBatchSound,
} from "../utils/suggestedBatch";
import { formatTimeShort } from "../utils/time";

type Props = {
  sounds: readonly SuggestedBatchSound[];
  trackLabel: (trackId: string) => string;
  /** False for a viewer who may not apply edits: the actions read as text. */
  canChange: boolean;
};

function AppliedSoundRow({
  sound,
  trackLabel,
  canChange,
}: {
  sound: SuggestedBatchSound;
  trackLabel: string;
  canChange: boolean;
}) {
  const selectId = useId();
  const at = sound.timelineStart;
  const name = `${sound.label}${at != null ? ` at ${formatTimeShort(at)}` : ""}, ${trackLabel}`;
  return (
    <li className="tighten-applied-row">
      {at != null ? (
        <Button
          variant="link"
          aria-label={`Go to ${name}`}
          onClick={() => void seekTransport(at)}
        >
          {formatTimeShort(at)}
        </Button>
      ) : (
        <span>Unmapped</span>
      )}
      <span className="tighten-applied-what">
        {sound.label} · {trackLabel}
      </span>
      {canChange ? (
        <>
          <label className="sr-only" htmlFor={selectId}>
            {`Action for ${name}`}
          </label>
          <select
            id={selectId}
            className="tighten-applied-action"
            value={sound.action}
            onChange={(e) => {
              const action = e.target.value;
              if (isSoundAction(action) && action !== sound.action) {
                runPointerCommand("tighten.reviseSuggested", {
                  id: sound.id,
                  action,
                });
              }
            }}
          >
            {SOUND_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {SOUND_ACTION_LABEL[action]}
              </option>
            ))}
          </select>
        </>
      ) : (
        <span>{SOUND_ACTION_LABEL[sound.action]}</span>
      )}
    </li>
  );
}

/**
 * The sounds Apply suggested actions just handled, each with the action it got. Changing
 * one re-applies the batch from before it, so the others keep their action and the whole
 * batch stays one undo step.
 */
export function AppliedSoundsList({ sounds, trackLabel, canChange }: Props) {
  const headingId = useId();
  if (sounds.length === 0) {
    return null;
  }
  return (
    <section className="tighten-applied" aria-labelledby={headingId}>
      <h3 id={headingId} className="tighten-applied-heading">
        Just applied ({sounds.length})
      </h3>
      <p className="tighten-status">
        Change one sound without undoing the rest. This stays until you make
        another edit.
      </p>
      <ul className="tighten-applied-list">
        {sounds.map((sound) => (
          <AppliedSoundRow
            key={sound.id}
            sound={sound}
            trackLabel={trackLabel(sound.trackId)}
            canChange={canChange}
          />
        ))}
      </ul>
    </section>
  );
}
