import { useEffect, useRef, useState } from "react";
import { setClipFade, setClipJoin } from "../../api";
import { capabilityTooltip } from "../../capabilities/copy";
import { executePointerCommand } from "../../commands/pointer";
import { clampFadeMs, edgeFadeMaxMs, maxFadeMs } from "../../edit/fadeLimits";
import {
  clipIdsBeforeCut,
  cutFadeHint,
  isCutJoin,
  JOIN_AUDITION_PAD_SEC,
  JOIN_MODE_OPTIONS,
  joinModeLabel,
  joinRenderNote,
} from "../../edit/joinRender";
import { muteRegionsOverlapping } from "../../edit/muteRegions";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { canApplyPass12, canSuggestStructural } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { ClipRow } from "../../types/project";
import {
  Button,
  DefItem,
  DefinitionList,
  FieldRow,
  InspectorSeekFooter,
} from "../../ui";
import { errorMessage } from "../../utils/apiError";
import { clipIdentityTrack, clipLabels } from "../../utils/clipLabels";
import { ModifierInspector } from "../ModifierInspector";

type FadePair = { inMs: number; outMs: number };
type FadeCapture = {
  projectPath: string;
  projectEpoch: number;
  clipId: string;
  trackId: string;
  sourceStart: number;
  sourceEnd: number;
  fadeInMs: number;
  fadeOutMs: number;
  fadeMaxMs: number | null;
  edge: "in" | "out";
};
type FadeGesture =
  | { kind: "idle" }
  | { kind: "preview"; capture: FadeCapture; pair: FadePair }
  | {
      kind: "committing";
      capture: FadeCapture;
      pair: FadePair;
      operation: number;
    };

const IDLE_FADE_GESTURE: FadeGesture = { kind: "idle" };
const isFadeAdjustmentKey = (key: string) =>
  [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
  ].includes(key);

export function ClipInspector({ clip }: { clip: ClipRow }) {
  const { projectPath, projectEpoch, guestMode, shareCapabilities } = useDaw(
    (s) => ({
      projectPath: s.projectPath,
      projectEpoch: s.projectEpoch,
      guestMode: s.guestMode,
      shareCapabilities: s.shareCapabilities,
    }),
  );
  const { busy, error, setError, run } = useProjectMutation();
  const [fadeGesture, setFadeGesture] =
    useState<FadeGesture>(IDLE_FADE_GESTURE);
  const fadeGestureRef = useRef<FadeGesture>(IDLE_FADE_GESTURE);
  const operationRef = useRef(0);
  const [fadeError, setFadeError] = useState<string | null>(null);
  const [joinLengthStr, setJoinLengthStr] = useState("");

  const changeFadeGesture = (next: FadeGesture) => {
    fadeGestureRef.current = next;
    setFadeGesture(next);
  };

  // undefined: the clip's track is not in the view yet (cap unknown);
  // null: the track is uncapped.
  const trackFadeMaxMs = useDawStore((s) => {
    const track = s.project?.tracks.find((t) => t.id === clip.track_id);
    return track === undefined ? undefined : (track.fade_max_ms ?? null);
  });
  useEffect(() => {
    const active = fadeGestureRef.current;
    if (active.kind === "committing") {
      const capture = active.capture;
      const state = useDawStore.getState();
      const sameEditorIdentity =
        state.projectPath === capture.projectPath &&
        state.projectEpoch === capture.projectEpoch &&
        clip.id === capture.clipId &&
        clip.track_id === capture.trackId &&
        clip.source_start === capture.sourceStart &&
        clip.source_end === capture.sourceEnd;
      if (!sameEditorIdentity) {
        operationRef.current += 1;
        changeFadeGesture(IDLE_FADE_GESTURE);
      }
    } else if (
      active.kind === "preview" &&
      (active.capture.projectPath !== projectPath ||
        active.capture.projectEpoch !== projectEpoch ||
        active.capture.clipId !== clip.id ||
        active.capture.trackId !== clip.track_id ||
        active.capture.sourceStart !== clip.source_start ||
        active.capture.sourceEnd !== clip.source_end ||
        active.capture.fadeInMs !== clip.fade_in_ms ||
        active.capture.fadeOutMs !== clip.fade_out_ms ||
        active.capture.fadeMaxMs !== (trackFadeMaxMs ?? null))
    ) {
      changeFadeGesture(IDLE_FADE_GESTURE);
    }
    setFadeError(null);
    setError(null);
  }, [
    projectPath,
    projectEpoch,
    clip.id,
    clip.track_id,
    clip.source_start,
    clip.source_end,
    clip.fade_in_ms,
    clip.fade_out_ms,
    trackFadeMaxMs,
    setError,
  ]);

  useEffect(() => {
    setJoinLengthStr("");
  }, [clip.id]);
  const capKnown = trackFadeMaxMs !== undefined;
  const clipSec = clip.source_end - clip.source_start;
  const fadeLimitMs = maxFadeMs(clipSec, trackFadeMaxMs);
  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const canStructural = canSuggestStructural(
    projectPath,
    guestMode,
    shareCapabilities,
  );

  // Render ignores the fades at a cut join: this clip's fade-in when its
  // incoming join is a cut, its fade-out when the next clip's join is.
  const cutIn = isCutJoin(clip);
  const cutOut = useDawStore((s) =>
    clipIdsBeforeCut(s.project?.clips?.tracks?.[clip.track_id] ?? []).has(
      clip.id,
    ),
  );
  // A trim keeps mutes the clip no longer covers; list only those it plays.
  const playedMutes = muteRegionsOverlapping(
    clip.mute_regions,
    clip.source_start,
    clip.source_end,
  );
  const currentClip = (capture: FadeCapture) => {
    const state = useDawStore.getState();
    const stored = state.project?.clips.tracks[capture.trackId]?.find(
      (row) => row.id === capture.clipId,
    );
    const track = state.project?.tracks.find(
      (row) => row.id === capture.trackId,
    );
    return { state, stored, track };
  };
  const identityIsCurrent = (capture: FadeCapture) => {
    const { state, stored, track } = currentClip(capture);
    return (
      state.projectPath === capture.projectPath &&
      state.projectEpoch === capture.projectEpoch &&
      stored?.track_id === capture.trackId &&
      stored.source_start === capture.sourceStart &&
      stored.source_end === capture.sourceEnd &&
      (track?.fade_max_ms ?? null) === capture.fadeMaxMs
    );
  };
  const savedPairIsCurrent = (capture: FadeCapture) => {
    const { stored } = currentClip(capture);
    return (
      identityIsCurrent(capture) &&
      stored?.fade_in_ms === capture.fadeInMs &&
      stored.fade_out_ms === capture.fadeOutMs
    );
  };
  const visibleFadePair =
    fadeGesture.kind === "preview"
      ? fadeGesture.pair
      : fadeGesture.kind === "committing" &&
          savedPairIsCurrent(fadeGesture.capture)
        ? fadeGesture.pair
        : { inMs: clip.fade_in_ms, outMs: clip.fade_out_ms };
  const isFadeBusy = fadeGesture.kind === "committing";
  const clipMutationBusy = busy || isFadeBusy;

  const beginFadeGesture = (edge: FadeCapture["edge"]) => {
    if (
      !editable ||
      !capKnown ||
      busy ||
      fadeGestureRef.current.kind !== "idle"
    )
      return;
    const state = useDawStore.getState();
    const stored = state.project?.clips.tracks[clip.track_id]?.find(
      (row) => row.id === clip.id,
    );
    if (
      !stored ||
      stored.source_start !== clip.source_start ||
      stored.source_end !== clip.source_end ||
      stored.fade_in_ms !== clip.fade_in_ms ||
      stored.fade_out_ms !== clip.fade_out_ms
    ) {
      return;
    }
    const capture: FadeCapture = {
      projectPath: state.projectPath,
      projectEpoch: state.projectEpoch,
      clipId: clip.id,
      trackId: clip.track_id,
      sourceStart: clip.source_start,
      sourceEnd: clip.source_end,
      fadeInMs: clip.fade_in_ms,
      fadeOutMs: clip.fade_out_ms,
      fadeMaxMs: trackFadeMaxMs,
      edge,
    };
    changeFadeGesture({ kind: "preview", capture, pair: visibleFadePair });
  };
  const previewFadeValue = (edge: FadeCapture["edge"], rawValue: number) => {
    const active = fadeGestureRef.current;
    if (active.kind !== "preview" || active.capture.edge !== edge) return;
    const max = edgeFadeMaxMs(
      clipSec,
      trackFadeMaxMs,
      edge === "in" ? active.pair.outMs : active.pair.inMs,
    );
    const value = clampFadeMs(rawValue, max);
    const pair =
      edge === "in"
        ? { ...active.pair, inMs: value }
        : { ...active.pair, outMs: value };
    changeFadeGesture({ ...active, pair });
  };
  const cancelFadeGesture = () => {
    const active = fadeGestureRef.current;
    if (active.kind !== "preview") return;
    if (identityIsCurrent(active.capture)) {
      setFadeError(null);
    }
    changeFadeGesture(IDLE_FADE_GESTURE);
  };
  const commitFadeGesture = async (edge?: FadeCapture["edge"]) => {
    const active = fadeGestureRef.current;
    if (active.kind !== "preview" || (edge && active.capture.edge !== edge)) {
      return;
    }
    const { capture, pair } = active;
    if (pair.inMs === capture.fadeInMs && pair.outMs === capture.fadeOutMs) {
      changeFadeGesture(IDLE_FADE_GESTURE);
      return;
    }
    if (!savedPairIsCurrent(capture)) {
      cancelFadeGesture();
      return;
    }
    const operation = ++operationRef.current;
    changeFadeGesture({ kind: "committing", capture, pair, operation });
    setFadeError(null);
    try {
      await setClipFade(
        capture.projectPath,
        capture.clipId,
        pair.inMs,
        pair.outMs,
        { fade_in_ms: capture.fadeInMs, fade_out_ms: capture.fadeOutMs },
      );
      const currentGesture = fadeGestureRef.current;
      if (
        currentGesture.kind === "committing" &&
        currentGesture.operation === operation
      ) {
        changeFadeGesture(IDLE_FADE_GESTURE);
      }
    } catch (error) {
      const currentGesture = fadeGestureRef.current;
      if (
        currentGesture.kind === "committing" &&
        currentGesture.operation === operation
      ) {
        if (identityIsCurrent(capture)) {
          setFadeError(errorMessage(error));
        }
        changeFadeGesture(IDLE_FADE_GESTURE);
      }
    }
  };
  const startKeyFade = (edge: FadeCapture["edge"], key: string) => {
    if (!isFadeAdjustmentKey(key)) {
      return;
    }
    if (fadeGestureRef.current.kind === "idle") beginFadeGesture(edge);
  };

  useEffect(
    () => () => {
      fadeGestureRef.current = IDLE_FADE_GESTURE;
    },
    [],
  );

  const leftClipId = clip.join_left_clip_id ?? null;
  const fadeHint = cutFadeHint(cutIn, cutOut);
  const joinNote = joinRenderNote(clip);

  // Empty length lets the server pick the mode's default; a typed length is used once.
  const commitJoin = async (mode: string, lengthStr: string) => {
    if (clipMutationBusy || leftClipId === null) {
      return;
    }
    const trimmed = lengthStr.trim();
    const length = trimmed === "" ? null : Number(trimmed);
    if (length !== null && !(Number.isInteger(length) && length >= 0)) {
      setError("Join length must be a non-negative integer (ms)");
      return;
    }
    if (mode === "crossfade" && length === 0) {
      // A crossfade needs an overlap; drop the 0 so the next mode change does not resend it.
      setJoinLengthStr("");
      setError("Crossfade length must be at least 1 ms");
      return;
    }
    const saved = await run(async () => {
      await setClipJoin(projectPath, leftClipId, clip.id, mode, length);
      return true;
    });
    if (saved) {
      // A typed length applies once; the next mode change uses the default.
      setJoinLengthStr("");
    }
  };

  const runDelete = async (ripple: boolean) => {
    if (clipMutationBusy) return;
    await run(async () => {
      const result = await executePointerCommand(
        ripple ? "edit.rippleDelete" : "edit.delete",
        { clipId: clip.id },
      );
      if (result.status !== "ok") {
        throw new Error(
          result.status === "disabled"
            ? result.reason
            : "Delete command unknown",
        );
      }
    });
  };

  const joinSec = clip.timeline_start;
  const trackIdentity = useDawStore((state) =>
    clipIdentityTrack({ clip, tracks: state.project?.tracks ?? [] }),
  );
  const labels = clipLabels({
    clip,
    trackSpeaker: trackIdentity?.speaker,
    trackLabel: trackIdentity?.label,
    role: trackIdentity?.role ?? "audio",
  });

  return (
    <ModifierInspector
      badge="Clip"
      title={labels.heading}
      error={error ?? fadeError}
      footer={
        <InspectorSeekFooter
          seekSec={joinSec}
          playStart={joinSec}
          playEnd={joinSec}
          padSec={JOIN_AUDITION_PAD_SEC}
          seekLabel="Seek join"
          playLabel="Play across join"
        />
      }
    >
      <DefinitionList>
        <DefItem label="ID">{clip.id}</DefItem>
        <DefItem label="Timeline">
          {labels.start} to {labels.end}
        </DefItem>
        <DefItem label="Source">
          {clip.source_start.toFixed(3)} – {clip.source_end.toFixed(3)} s
        </DefItem>
        <DefItem label="Fades">
          {editable ? (
            <div className="clip-fade-controls">
              {(["in", "out"] as const).map((edge) => {
                const incoming = edge === "in";
                const fadeKey = incoming ? "inMs" : "outMs";
                const oppositeKey = incoming ? "outMs" : "inMs";
                const edgeCut = incoming ? cutIn : cutOut;
                const edgeValue = visibleFadePair[fadeKey];
                const activePreview =
                  fadeGesture.kind === "preview" &&
                  fadeGesture.capture.edge !== edge;
                return (
                  <label className="clip-fade-control" key={edge}>
                    <span>{incoming ? "In" : "Out"}</span>
                    <input
                      type="range"
                      min={0}
                      max={edgeFadeMaxMs(
                        clipSec,
                        trackFadeMaxMs,
                        visibleFadePair[oppositeKey],
                      )}
                      step={1}
                      value={edgeValue}
                      disabled={
                        clipMutationBusy ||
                        activePreview ||
                        !capKnown ||
                        edgeCut
                      }
                      aria-label={`Fade ${edge} ms`}
                      onPointerDown={() => beginFadeGesture(edge)}
                      onPointerUp={() => void commitFadeGesture(edge)}
                      onPointerCancel={cancelFadeGesture}
                      onLostPointerCapture={cancelFadeGesture}
                      onBlur={() => {
                        if (fadeGestureRef.current.kind === "preview") {
                          void commitFadeGesture(edge);
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelFadeGesture();
                        } else {
                          startKeyFade(edge, event.key);
                        }
                      }}
                      onKeyUp={(event) => {
                        if (isFadeAdjustmentKey(event.key)) {
                          void commitFadeGesture(edge);
                        }
                      }}
                      onChange={(event) => {
                        if (fadeGestureRef.current.kind === "idle") {
                          beginFadeGesture(edge);
                        }
                        previewFadeValue(
                          edge,
                          Number(event.currentTarget.value),
                        );
                      }}
                    />
                    <output>{edgeValue} ms</output>
                  </label>
                );
              })}
              {capKnown ? (
                <span className="ui-field-hint" role="status">
                  {[fadeHint, `max ${fadeLimitMs} ms`]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              in {clip.fade_in_ms} ms / out {clip.fade_out_ms} ms
            </>
          )}
        </DefItem>
        {leftClipId !== null ? (
          <DefItem label="Incoming transition">
            {editable ? (
              <FieldRow>
                <select
                  value={clip.join_in_mode}
                  disabled={clipMutationBusy}
                  aria-label="Incoming transition"
                  title={capabilityTooltip("daw.edit.setClipJoin")}
                  onChange={(e) =>
                    void commitJoin(e.target.value, joinLengthStr)
                  }
                >
                  {JOIN_MODE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {cutIn ? null : (
                  <>
                    <input
                      type="number"
                      min={clip.join_in_mode === "crossfade" ? 1 : 0}
                      step={1}
                      value={joinLengthStr}
                      placeholder="default"
                      disabled={clipMutationBusy}
                      aria-label="Transition length ms"
                      onChange={(e) => setJoinLengthStr(e.target.value)}
                    />
                    <span>ms</span>
                    <Button
                      disabled={clipMutationBusy || joinLengthStr.trim() === ""}
                      onClick={() =>
                        void commitJoin(clip.join_in_mode, joinLengthStr)
                      }
                    >
                      Apply transition length
                    </Button>
                  </>
                )}
              </FieldRow>
            ) : (
              joinModeLabel(clip.join_in_mode)
            )}
            <span className="ui-field-hint" role="status">
              Controls the incoming join from the previous clip into this one.
            </span>
            {joinNote ? (
              <span className="ui-field-hint" role="status">
                {joinNote}
              </span>
            ) : null}
          </DefItem>
        ) : null}
        {clip.source_id ? (
          <DefItem label="Source ID">{clip.source_id}</DefItem>
        ) : null}
        {playedMutes.length > 0 ? (
          <DefItem label="Mute regions">
            {playedMutes
              .map(
                (region) =>
                  `${region.start_s.toFixed(3)}–${region.end_s.toFixed(3)} s`,
              )
              .join(", ")}
          </DefItem>
        ) : null}
      </DefinitionList>
      {canStructural ? (
        <section className="clip-destructive-controls" aria-label="Delete clip">
          <h3>Delete clip</h3>
          <FieldRow>
            <Button
              variant="danger"
              disabled={clipMutationBusy}
              onClick={() => void runDelete(false)}
            >
              Delete
            </Button>
            <Button
              variant="danger"
              disabled={clipMutationBusy}
              onClick={() => void runDelete(true)}
            >
              Ripple delete
            </Button>
          </FieldRow>
        </section>
      ) : null}
    </ModifierInspector>
  );
}
