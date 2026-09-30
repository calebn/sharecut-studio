import { useEffect, useId, useRef, useState } from "react";
import { useTrackMetaMutation } from "../hooks/useTrackMetaMutation";
import type { TrackView } from "../types/project";
import { Button, InlineError } from "../ui";

export function TranscriptSpeakerEditor({
  track,
  speaker,
  speakers,
  onClose,
  onBusyChange,
}: {
  track: TrackView;
  speaker: string;
  speakers: readonly string[];
  onClose: (restoreFocus: boolean) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [name, setName] = useState(track.speaker ?? speaker);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const savingRef = useRef(false);
  const id = useId();
  const { busy, error, setError, saveMetaFields } = useTrackMetaMutation(
    track.id,
  );
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const save = async () => {
    if (savingRef.current) return;
    const next = name.trim();
    if (!next) {
      setError("Enter a speaker name.");
      return;
    }
    if (next === (track.speaker ?? speaker)) {
      onClose(true);
      return;
    }
    savingRef.current = true;
    onBusyChange(true);
    const saved = await saveMetaFields({ speaker: next });
    savingRef.current = false;
    onBusyChange(false);
    if (saved)
      onClose(formRef.current?.contains(document.activeElement) ?? false);
  };

  return (
    <form
      ref={formRef}
      className="transcript-inline-editor transcript-speaker-editor"
      aria-label={`Change speaker for ${track.label || track.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <input
        ref={inputRef}
        className="transcript-inline-input"
        aria-label="Speaker name"
        aria-describedby={id}
        aria-invalid={error ? true : undefined}
        list={`${id}-speakers`}
        value={name}
        readOnly={busy}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!savingRef.current) onClose(true);
          }
        }}
      />
      <datalist id={`${id}-speakers`}>
        {speakers.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>
      <span id={id}>All turns on {track.label || track.id}.</span>
      <Button type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save speaker"}
      </Button>
      <Button disabled={busy} onClick={() => onClose(true)}>
        Cancel
      </Button>
      <InlineError inline role="alert" message={error} />
    </form>
  );
}
