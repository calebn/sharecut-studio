import type { CSSProperties } from "react";
import { Icon } from "../ui/Icon";
import { RippleMark } from "../ui/RippleMark";

export type ScopeTrack = {
  readonly id: string;
  readonly name: string;
  /** A CSS colour token, such as `var(--color-clip-dialogue-0)`. */
  readonly color: string;
};

export type ScopeChipProps = {
  readonly tracks: readonly ScopeTrack[];
  readonly all: boolean;
  /** True when the cut closes time; false when it leaves a gap. */
  readonly ripple: boolean;
  /** Absent for a read-only guest: the chip is then a label, not a button. */
  readonly onToggle?: () => void;
};

const MAX_DOTS = 3;

export function ScopeChip({ tracks, all, ripple, onToggle }: ScopeChipProps) {
  const shown = tracks.slice(0, MAX_DOTS);
  const body = (
    <>
      {all ? (
        <span>All</span>
      ) : (
        <>
          <span className="sys-scope-dots" aria-hidden="true">
            {shown.map((track) => (
              <span
                key={track.id}
                className="sys-scope-dot"
                style={{ "--sys-scope-color": track.color } as CSSProperties}
              />
            ))}
            {tracks.length > shown.length ? (
              <span>+{tracks.length - shown.length}</span>
            ) : null}
          </span>
          <span className="sr-only">
            {tracks.map((track) => track.name).join(", ")}
          </span>
        </>
      )}
      <span className="sys-scope-mode">
        {ripple ? (
          <RippleMark />
        ) : (
          <span role="img" aria-label="Leave gap">
            <Icon name="flatline" />
          </span>
        )}
      </span>
    </>
  );
  return onToggle ? (
    <button
      type="button"
      className="sys-scope"
      title="Change the tracks"
      onClick={onToggle}
    >
      {body}
    </button>
  ) : (
    <span className="sys-scope">{body}</span>
  );
}
