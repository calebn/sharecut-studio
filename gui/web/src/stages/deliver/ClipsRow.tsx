import { useState } from "react";
import { Skeleton } from "../../system/Skeleton";
import { SystemIcon } from "../../system/SystemIcon";
import { formatSeconds } from "../../system/seconds";
import { TimeField } from "../../system/TimeField";
import { VerbButton } from "../../system/VerbButton";
import { hintOf, iconOf, verbOf } from "../../system/verbDisplay";
import { Button, EmptyState, Menu, MenuItem } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import {
  type Clip,
  clipSeconds,
  clipStrength,
  formatClock,
  itemNames,
  parseClock,
} from "./deliverLogic";

type Props = {
  clips: readonly Clip[];
  /** Episode length in seconds. */
  total: number;
  state?: "ready" | "loading";
  /** The clip whose In and Out are open for trimming. */
  trimming?: string | null;
  onRetitle: (id: string, title: string) => void;
  onTrim: (id: string, edge: "start" | "end", at: number) => void;
  onPlay: (id: string) => void;
  onApprove: (id: string) => void;
  onRemove: (id: string) => void;
  onOpenInEdit: (id: string) => void;
  onFind: () => void;
};

const STRENGTH_NAME = ["Weak", "Fair", "Strong"] as const;

function ClipMenu({
  name,
  trimming,
  onTrim,
  onOpenInEdit,
  onRemove,
}: {
  name: string;
  trimming: boolean;
  onTrim: () => void;
  onOpenInEdit: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const more = verbOf("more");
  const pick = (act: () => void) => () => {
    setOpen(false);
    act();
  };
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      label={`${more.label} for ${name}`}
      trigger={(props) => (
        <Button
          {...props}
          aria-label={`${more.label} for ${name}`}
          title={`${more.label}${hintOf(more)}`}
        >
          <SystemIcon name={iconOf("more")} size={16} />
        </Button>
      )}
    >
      <MenuItem onSelect={pick(onTrim)}>
        {trimming ? "Done trimming" : "Trim"}
      </MenuItem>
      <MenuItem onSelect={pick(onOpenInEdit)}>Open in Edit</MenuItem>
      <MenuItem onSelect={pick(onRemove)}>{verbOf("remove").label}</MenuItem>
    </Menu>
  );
}

/** Approved clips export with the episode. */
export function ClipsRow({
  clips,
  total,
  state = "ready",
  trimming: initialTrimming = null,
  onRetitle,
  onTrim,
  onPlay,
  onApprove,
  onRemove,
  onOpenInEdit,
  onFind,
}: Props) {
  const [trimming, setTrimming] = useState<string | null>(initialTrimming);
  const names = itemNames(
    clips.map((c) => c.title),
    "clip",
  );
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
  return (
    <DeliverSection title="Clips" action={clips.length > 0 ? find : undefined}>
      {clips.length === 0 ? (
        <EmptyState as="div">
          No clip ideas yet.
          {find}
        </EmptyState>
      ) : (
        <ul className="dv-clips" data-focus-list="clips">
          {clips.map((clip, index) => {
            const name = names[index] ?? clip.title;
            const strength = clipStrength(clip.score);
            const trim = trimming === clip.id;
            return (
              <li
                key={clip.id}
                className="dv-clip"
                data-approved={clip.approved || undefined}
              >
                <div className="dv-clip-wave">
                  <VerbButton
                    verb="play"
                    label={`Play ${name}`}
                    onClick={() => onPlay(clip.id)}
                  />
                </div>
                <input
                  className="dv-clip-title"
                  aria-label={`Title of ${name}`}
                  value={clip.title}
                  onChange={(event) => onRetitle(clip.id, event.target.value)}
                />
                {trim ? (
                  <div className="dv-clip-trim">
                    <TimeField
                      label={`In of ${name}`}
                      value={clip.start}
                      min={0}
                      max={total}
                      step={0.1}
                      format={formatClock}
                      parse={parseClock}
                      onChange={(at) => onTrim(clip.id, "start", at)}
                    />
                    <TimeField
                      label={`Out of ${name}`}
                      value={clip.end}
                      min={0}
                      max={total}
                      step={0.1}
                      format={formatClock}
                      parse={parseClock}
                      onChange={(at) => onTrim(clip.id, "end", at)}
                    />
                  </div>
                ) : null}
                <div className="dv-clip-meta">
                  <span className="sys-mono">
                    {formatSeconds(clipSeconds(clip))}
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
                    <span
                      className="dv-clip-approved"
                      tabIndex={-1}
                      data-focus-key={`clip:${clip.id}:approve`}
                    >
                      <SystemIcon name={iconOf("approve")} size={14} />
                      Approved
                    </span>
                  ) : (
                    <Button
                      data-focus-key={`clip:${clip.id}:approve`}
                      aria-label={`Approve ${name}`}
                      onClick={() => onApprove(clip.id)}
                    >
                      <SystemIcon name={iconOf("approve")} size={14} />
                      Approve
                    </Button>
                  )}
                  <ClipMenu
                    name={name}
                    trimming={trim}
                    onTrim={() => setTrimming(trim ? null : clip.id)}
                    onOpenInEdit={() => onOpenInEdit(clip.id)}
                    onRemove={() => onRemove(clip.id)}
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
