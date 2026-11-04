import { ToggleButton } from "../../ui";

export type ScopeTrack = { id: string; label: string };

/** Which tracks a comment is about; none chosen means the whole session. */
export function TrackScope({
  tracks,
  value,
  onChange,
  disabled,
}: {
  tracks: readonly ScopeTrack[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const toggle = (id: string) => {
    const next = value.includes(id)
      ? value.filter((x) => x !== id)
      : [...value, id];
    onChange(next.length === tracks.length ? [] : next);
  };
  return (
    <div className="rv-scope" role="group" aria-label="Comment on tracks">
      <ToggleButton
        quiet
        pressed={value.length === 0}
        aria-disabled={disabled || undefined}
        onClick={() => {
          if (!disabled) onChange([]);
        }}
      >
        All tracks
      </ToggleButton>
      {tracks.map((track) => (
        <ToggleButton
          key={track.id}
          quiet
          pressed={value.includes(track.id)}
          aria-disabled={disabled || undefined}
          onClick={() => {
            if (!disabled) toggle(track.id);
          }}
        >
          <span className="rv-scope-name">{track.label}</span>
        </ToggleButton>
      ))}
    </div>
  );
}
