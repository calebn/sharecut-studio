import { useEffect, useRef, useState } from "react";
import {
  applyClipPlacement,
  beginClipPlacement,
  cancelClipPlacement,
  canPlaceClips,
  updateClipPlacement,
  useClipPlacement,
} from "../../edit/clipPlacement";
import { useDawStore } from "../../state/dawStore";
import { Button, FieldRow, InlineError } from "../../ui";

export function ClipPlacementControls({
  clipId,
  busy,
}: {
  clipId: string;
  busy: boolean;
}) {
  const placement = useClipPlacement();
  const allowed = useDawStore(canPlaceClips);
  const tokenRef = useRef<number | null>(null);
  const [ownedToken, setOwnedToken] = useState<number | null>(null);
  const returnFocusRef = useRef(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const active =
    placement.kind !== "idle" &&
    placement.capture.anchorId === clipId &&
    placement.capture.token === ownedToken
      ? placement
      : null;
  const token = active?.capture.token;
  useEffect(() => {
    if (token !== undefined) {
      formRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false;
      entryRef.current?.focus();
    }
  }, [token]);
  useEffect(() => {
    const cancel = () => {
      if (tokenRef.current !== null) cancelClipPlacement(tokenRef.current);
    };
    const visibility = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [clipId]);
  const close = () => {
    returnFocusRef.current = true;
    if (token !== undefined) cancelClipPlacement(token);
  };
  const disabled = busy || !allowed || active?.kind === "committing";
  return (
    <div
      ref={formRef}
      role="group"
      aria-label="Clip placement"
      tabIndex={-1}
      className="clip-placement-controls"
      onKeyDownCapture={(event) => {
        if (event.key === "Escape" && active) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }}
    >
      {active ? (
        <>
          <p>
            {active.capture.movingIds.length > 1
              ? `Move ${active.capture.movingIds.length} selected clips`
              : "Move clip"}
          </p>
          <label>
            Target track
            <select
              value={active.trackId}
              disabled={disabled}
              onChange={(event) =>
                updateClipPlacement(
                  active.capture.token,
                  active.start,
                  event.target.value,
                )
              }
            >
              {active.capture.basis.tracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Timeline start (seconds)
            <input
              type="number"
              min={0}
              step="any"
              inputMode="decimal"
              value={active.start}
              disabled={disabled}
              onChange={(event) =>
                updateClipPlacement(
                  active.capture.token,
                  event.target.value,
                  active.trackId,
                )
              }
            />
          </label>
          <FieldRow>
            {[-0.01, 0.01].map((delta) => (
              <Button
                key={delta}
                disabledReason={
                  disabled ? "Wait for the current edit to finish." : undefined
                }
                onClick={() =>
                  updateClipPlacement(
                    active.capture.token,
                    String(
                      Math.max(
                        0,
                        Math.round((Number(active.start || 0) + delta) * 1e9) /
                          1e9,
                      ),
                    ),
                    active.trackId,
                  )
                }
              >
                {delta < 0 ? "Earlier 10 ms" : "Later 10 ms"}
              </Button>
            ))}
            <Button
              disabledReason={
                disabled ? "Wait for the current edit to finish." : undefined
              }
              onClick={() =>
                updateClipPlacement(
                  active.capture.token,
                  String(useDawStore.getState().playheadSec),
                  active.trackId,
                )
              }
            >
              Use playhead
            </Button>
          </FieldRow>
          <p className="ui-field-hint">
            Preview only. Apply move saves one edit. Clips keep their spacing
            until a timeline or track boundary.
          </p>
          {active.error ? <InlineError message={active.error} /> : null}
          <FieldRow>
            <Button
              variant="primary"
              disabledReason={
                disabled
                  ? "Wait for the current edit to finish."
                  : active.placements.length === 0
                    ? (active.error ?? "Choose a valid destination.")
                    : undefined
              }
              onClick={() => void applyClipPlacement(active.capture.token)}
            >
              {active.kind === "committing" ? "Applying move…" : "Apply move"}
            </Button>
            <Button
              disabledReason={
                active.kind === "committing"
                  ? "Wait for the move to finish."
                  : undefined
              }
              onClick={close}
            >
              Cancel
            </Button>
          </FieldRow>
        </>
      ) : (
        <Button
          ref={entryRef}
          disabledReason={
            !allowed
              ? "Clip moves require edit permission."
              : busy
                ? "Wait for the current edit to finish."
                : undefined
          }
          onClick={() => {
            const token = beginClipPlacement(clipId);
            tokenRef.current = token;
            setOwnedToken(token);
          }}
        >
          Move clip
        </Button>
      )}
    </div>
  );
}
