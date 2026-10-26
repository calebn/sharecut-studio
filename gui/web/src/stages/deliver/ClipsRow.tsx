import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { SystemIcon } from "../../system/SystemIcon";
import { formatSeconds } from "../../system/seconds";
import { VerbButton } from "../../system/VerbButton";
import { iconOf } from "../../system/verbDisplay";
import { Button, EmptyState } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import { type Clip, clipStrength } from "./deliverLogic";

type Props = {
  clips: readonly Clip[];
  state?: "ready" | "loading" | "error";
  onRetitle: (id: string, title: string) => void;
  onPlay: (id: string) => void;
  onApprove: (id: string) => void;
  onRemove: (id: string) => void;
  onFind: () => void;
  onRetry?: () => void;
};

const STRENGTH_NAME = ["Weak", "Fair", "Strong"] as const;

/** Clip ideas as cards. Approved clips export with the episode. */
export function ClipsRow({
  clips,
  state = "ready",
  onRetitle,
  onPlay,
  onApprove,
  onRemove,
  onFind,
  onRetry,
}: Props) {
  const find = (
    <Button variant="link" onClick={onFind}>
      Find clips
    </Button>
  );
  if (state === "loading") {
    return (
      <DeliverSection title="Clips">
        <Skeleton layout="cards" rows={3} />
      </DeliverSection>
    );
  }
  if (state === "error") {
    return (
      <DeliverSection title="Clips">
        <StatusRow
          state="failed"
          title="Could not load the clips"
          action={
            onRetry ? { label: "Try again", onAction: onRetry } : undefined
          }
        />
      </DeliverSection>
    );
  }
  return (
    <DeliverSection title="Clips" action={clips.length > 0 ? find : undefined}>
      {clips.length === 0 ? (
        <EmptyState as="div">
          No clip ideas yet.
          {find}
        </EmptyState>
      ) : (
        <ul className="dv-clips">
          {clips.map((clip) => {
            const strength = clipStrength(clip.score);
            return (
              <li
                key={clip.id}
                className="dv-clip"
                data-approved={clip.approved || undefined}
              >
                <div className="dv-clip-wave">
                  <VerbButton
                    verb="play"
                    label={`Play ${clip.title}`}
                    onClick={() => onPlay(clip.id)}
                  />
                </div>
                <input
                  className="dv-clip-title"
                  aria-label={`Title of ${clip.title}`}
                  value={clip.title}
                  onChange={(event) => onRetitle(clip.id, event.target.value)}
                />
                <div className="dv-clip-meta">
                  <span className="sys-mono">
                    {formatSeconds(clip.seconds)}
                  </span>
                  <span
                    className="dv-strength"
                    role="img"
                    aria-label={`${STRENGTH_NAME[strength - 1]} clip`}
                  >
                    {[1, 2, 3].map((bar) => (
                      <span
                        key={bar}
                        className="dv-strength-bar"
                        data-on={bar <= strength || undefined}
                      />
                    ))}
                  </span>
                </div>
                <div className="dv-clip-actions">
                  {clip.approved ? (
                    <span className="dv-clip-approved">
                      <SystemIcon name={iconOf("approve")} size={14} />
                      Approved
                    </span>
                  ) : (
                    <Button onClick={() => onApprove(clip.id)}>
                      <SystemIcon name={iconOf("approve")} size={14} />
                      Approve
                    </Button>
                  )}
                  <VerbButton
                    verb="remove"
                    label={`Remove ${clip.title}`}
                    onClick={() => onRemove(clip.id)}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DeliverSection>
  );
}
