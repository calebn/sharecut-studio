import { useEffect, useRef, useState } from "react";
import {
  applyClipPlacement,
  beginClipPlacement,
  cancelClipPlacement,
  canPlaceClips,
  getClipPlacement,
  updateClipPlacement,
} from "../../edit/clipPlacement";
import { useDawStore } from "../../state/dawStore";
import { ScrubField } from "../../system/ScrubField";
import type { ClipRow } from "../../types/project";
import { ToggleButton } from "../../ui";

/**
 * One clip move, driven by the Start field and the Track row. A drag on Start
 * previews the move on the timeline (the placement preview) and a release or
 * Enter saves one edit; tapping a track moves the clip there at the same time.
 * There is no form to apply or cancel: Escape in the scrub drops the preview.
 */
function useClipMove(clip: ClipRow) {
  const token = useRef<number | null>(null);
  const drop = () => {
    if (token.current !== null) cancelClipPlacement(token.current);
    token.current = null;
  };
  // A different clip, the sheet closing, a lost window or a hidden tab ends any
  // preview left open. Each ends only the placement this clip's fields began.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `drop` only reads a ref.
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) drop();
    };
    window.addEventListener("blur", drop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      drop();
      window.removeEventListener("blur", drop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [clip.id]);
  const open = () => {
    token.current ??= beginClipPlacement(clip.id);
    return token.current;
  };
  return {
    preview: (start: number, trackId: string) => {
      const at = open();
      if (at !== null) updateClipPlacement(at, String(start), trackId);
    },
    commit: async (start: number, trackId: string) => {
      const at = open();
      if (at === null) return;
      updateClipPlacement(at, String(start), trackId);
      await applyClipPlacement(at);
      token.current = null;
      const settled = getClipPlacement();
      if (settled.kind !== "idle" && settled.capture.token === at) {
        // A refused move has no form to show its error: say it and drop the ghost.
        if (settled.error)
          useDawStore
            .getState()
            .announceStatus(settled.error, { tone: "error" });
        cancelClipPlacement(at);
      }
    },
    cancel: drop,
  };
}

export function ClipStartField({
  clip,
  disabled,
}: {
  clip: ClipRow;
  disabled: boolean;
}) {
  const allowed = useDawStore(canPlaceClips);
  const move = useClipMove(clip);
  const [draft, setDraft] = useState<number | null>(null);
  return (
    <ScrubField
      label="Start"
      value={draft ?? clip.timeline_start}
      unit="s"
      step={0.01}
      decimals={3}
      min={0}
      skipUnchanged
      readOnly={disabled || !allowed}
      onPreview={(start) => {
        setDraft(start);
        move.preview(start, clip.track_id);
      }}
      onCancel={() => {
        setDraft(null);
        move.cancel();
      }}
      onCommit={(start) => {
        setDraft(null);
        void move.commit(start, clip.track_id);
      }}
    />
  );
}

export function ClipTrackRow({
  clip,
  tracks,
  disabled,
  reasonId,
}: {
  clip: ClipRow;
  tracks: readonly { id: string; label: string }[];
  disabled: boolean;
  reasonId?: string;
}) {
  const allowed = useDawStore(canPlaceClips);
  const move = useClipMove(clip);
  const locked = disabled || !allowed;
  return (
    <div className="track-toggle-row" role="group" aria-label="Move to track">
      {tracks.map((track) => (
        <ToggleButton
          key={track.id}
          quiet
          pressed={track.id === clip.track_id}
          aria-disabled={locked || undefined}
          aria-describedby={locked ? reasonId : undefined}
          onClick={() => {
            if (locked || track.id === clip.track_id) return;
            void move.commit(clip.timeline_start, track.id);
          }}
        >
          {track.label}
        </ToggleButton>
      ))}
    </div>
  );
}
