import { ToggleButton } from "../ui";

export type ToggleTrack = { id: string; label: string };

/**
 * Which tracks an edit covers, one toggle per track. At least one stays on:
 * the last toggle refuses to switch off, so the scope is never empty.
 */
export function TrackToggleRow({
  label,
  tracks,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  tracks: readonly ToggleTrack[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="track-toggle-row" role="group" aria-label={label}>
      {tracks.map((track) => {
        const on = value.includes(track.id);
        return (
          <ToggleButton
            key={track.id}
            quiet
            pressed={on}
            aria-disabled={disabled || undefined}
            onClick={() => {
              if (disabled) return;
              if (on && value.length === 1) return;
              onChange(
                on
                  ? value.filter((id) => id !== track.id)
                  : [...value, track.id],
              );
            }}
          >
            {track.label}
          </ToggleButton>
        );
      })}
    </div>
  );
}
