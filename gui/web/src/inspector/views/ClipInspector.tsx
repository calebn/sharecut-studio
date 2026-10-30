import { useEffect, useState } from "react";
import { setClipFade, setClipJoin } from "../../api";
import { capabilityTooltip } from "../../capabilities/copy";
import { commandLabel } from "../../commands/labels";
import { executePointerCommand } from "../../commands/pointer";
import { saveClipEdge, TRIM_MODE } from "../../edit/clipEdgeSave";
import { cancelClipPlacement } from "../../edit/clipPlacement";
import { edgeFadeMaxMs, maxFadeMs } from "../../edit/fadeLimits";
import {
  clipIdsBeforeCut,
  cutFadeHint,
  isCutJoin,
  JOIN_AUDITION_PAD_SEC,
  joinModeLabel,
  joinRenderNote,
} from "../../edit/joinRender";
import { muteRegionsOverlapping } from "../../edit/muteRegions";
import { NUDGE_KINDS, type NudgeField } from "../../edit/nudge";
import { trimEdgeLimits } from "../../edit/trimLimits";
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
import { BUSY_REASON } from "../../ui/disabledReason";
import { clipIdentityTrack, clipLabels } from "../../utils/clipLabels";
import { JOIN_MODE_OPTIONS } from "../../utils/editMarkerRegistry";
import { ModifierInspector } from "../ModifierInspector";
import { NudgeButtons, UNAPPLIED_VALUE_REASON } from "../NudgeButtons";
import { useNudgeRun } from "../useNudgeRun";
import { ClipPlacementControls } from "./ClipPlacementControls";

type TrimInputDraft = { baseline: number; text: string };
type TrimDraftState = {
  clipId: string;
  start: TrimInputDraft;
  end: TrimInputDraft;
};
type FadeDraft = { baseline: number; text: string };
type FadeDraftState = {
  clipId: string;
  in: FadeDraft | null;
  out: FadeDraft | null;
};

const FADE_AT_CUT_REASON = "Fades do not apply at a cut.";

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
  const [fadeDrafts, setFadeDrafts] = useState<FadeDraftState>({
    clipId: clip.id,
    in: null,
    out: null,
  });
  const [joinLengthStr, setJoinLengthStr] = useState("");
  const [trimDrafts, setTrimDrafts] = useState(() => ({
    clipId: clip.id,
    start: { baseline: clip.source_start, text: String(clip.source_start) },
    end: { baseline: clip.source_end, text: String(clip.source_end) },
  }));
  const trimRun = useNudgeRun();

  // undefined: the clip's track is not in the view yet (cap unknown);
  // null: the track is uncapped.
  const trackFadeMaxMs = useDawStore((s) => {
    const track = s.project?.tracks.find((t) => t.id === clip.track_id);
    return track === undefined ? undefined : (track.fade_max_ms ?? null);
  });
  useEffect(() => {
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
    setFadeDrafts({ clipId: "", in: null, out: null });
  }, [projectPath, projectEpoch]);

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
  const clipMutationBusy = busy || trimRun.saving;

  const trimField = (edge: "in" | "out"): NudgeField => ({
    kind: "trim",
    trackId: clip.track_id,
    clipId: clip.id,
    edge,
  });
  const startDraft = trimDrafts.clipId === clip.id ? trimDrafts.start : null;
  const endDraft = trimDrafts.clipId === clip.id ? trimDrafts.end : null;
  const sourceStartStr =
    startDraft && startDraft.text !== String(startDraft.baseline)
      ? startDraft.text
      : String(clip.source_start);
  const sourceEndStr =
    endDraft && endDraft.text !== String(endDraft.baseline)
      ? endDraft.text
      : String(clip.source_end);
  const trimDraft = (edge: "in" | "out") =>
    edge === "in" ? sourceStartStr : sourceEndStr;
  const setTrimDraft = (edge: "in" | "out", value: string) => {
    setTrimDrafts((current): TrimDraftState => {
      const next =
        current.clipId === clip.id
          ? current
          : {
              clipId: clip.id,
              start: {
                baseline: clip.source_start,
                text: String(clip.source_start),
              },
              end: {
                baseline: clip.source_end,
                text: String(clip.source_end),
              },
            };
      return edge === "in"
        ? {
            ...next,
            start: { baseline: clip.source_start, text: value },
          }
        : { ...next, end: { baseline: clip.source_end, text: value } };
    });
  };
  const trimDraftIsStale = (edge: "in" | "out") => {
    const draft = edge === "in" ? startDraft : endDraft;
    const current = edge === "in" ? clip.source_start : clip.source_end;
    return (
      draft != null &&
      draft.text !== String(draft.baseline) &&
      draft.baseline !== current
    );
  };
  const trimIsDirty = (edge: "in" | "out") =>
    trimDraft(edge) !==
    String(edge === "in" ? clip.source_start : clip.source_end);
  const trimBounds = (edge: "in" | "out") => {
    const lane =
      useDawStore.getState().project?.clips.tracks[clip.track_id] ?? [];
    const index = lane.findIndex((item) => item.id === clip.id);
    return index < 0 ? null : trimEdgeLimits(lane, index, edge, TRIM_MODE);
  };
  const commitTrim = async (edge: "in" | "out") => {
    if (!editable || clipMutationBusy || trimRun.running) return;
    if (trimDraftIsStale(edge)) {
      setError(
        "This clip changed while its source field was being edited. Reload the clip before trimming.",
      );
      return;
    }
    const text = trimDraft(edge).trim();
    const value = Number(text);
    if (!text || !Number.isFinite(value)) {
      setError(
        `Source ${edge === "in" ? "start" : "end"} must be a finite number of seconds.`,
      );
      return;
    }
    const bounds = trimBounds(edge);
    if (!bounds || value < bounds.lo || value > bounds.hi) {
      setError(
        `Source ${edge === "in" ? "start" : "end"} must be between ${bounds?.lo ?? "the current clip bounds"} and ${bounds?.hi ?? "the current clip bounds"} seconds.`,
      );
      return;
    }
    const state = useDawStore.getState();
    const current = state.project?.clips.tracks[clip.track_id]?.find(
      (item) => item.id === clip.id,
    );
    if (
      state.projectPath !== projectPath ||
      state.projectEpoch !== projectEpoch ||
      current?.source_start !== clip.source_start ||
      current.source_end !== clip.source_end
    ) {
      setError("This clip changed. Reload its source bounds before trimming.");
      return;
    }
    cancelClipPlacement();
    const saved = await run(async () => {
      const fresh = () => {
        const latest = useDawStore.getState();
        const saved = latest.project?.clips.tracks[clip.track_id]?.find(
          (item) => item.id === clip.id,
        );
        return (
          latest.projectPath === projectPath &&
          latest.projectEpoch === projectEpoch &&
          saved?.source_start === clip.source_start &&
          saved.source_end === clip.source_end
        );
      };
      return saveClipEdge(
        projectPath,
        clip,
        {
          kind: "trim",
          edge,
          mode: TRIM_MODE,
          sourceSec: value,
        },
        fresh,
      );
    });
    if (saved) {
      const start = edge === "in" ? value : clip.source_start;
      const end = edge === "out" ? value : clip.source_end;
      setTrimDrafts({
        clipId: clip.id,
        start: { baseline: start, text: String(start) },
        end: { baseline: end, text: String(end) },
      });
    }
  };

  const renderTrimField = (edge: "in" | "out") => {
    const name = edge === "in" ? "start" : "end";
    const field = trimField(edge);
    const kind = NUDGE_KINDS.trim;
    const [small, large] = kind.steps;
    const deltas = [-large, -small, small, large];
    const dirty = trimIsDirty(edge);
    return (
      <DefItem label={`Source ${name}`} key={edge}>
        {editable ? (
          <>
            <FieldRow>
              <input
                type="number"
                min={trimBounds(edge)?.lo}
                max={trimBounds(edge)?.hi}
                step="any"
                inputMode="decimal"
                aria-label={`Source ${name}`}
                value={trimDraft(edge)}
                disabled={clipMutationBusy || trimRun.running}
                onChange={(event) => setTrimDraft(edge, event.target.value)}
              />
              <Button
                disabledReason={
                  clipMutationBusy || trimRun.running ? BUSY_REASON : undefined
                }
                onClick={() => void commitTrim(edge)}
              >
                Apply source {name}
              </Button>
            </FieldRow>
            <NudgeButtons
              groupLabel={`Nudge source ${name}`}
              deltas={deltas}
              unavailable={
                clipMutationBusy
                  ? BUSY_REASON
                  : dirty
                    ? UNAPPLIED_VALUE_REASON
                    : undefined
              }
              onPointerDownCapture={() => {
                if (!clipMutationBusy && !dirty) cancelClipPlacement();
              }}
              label={(delta) =>
                `${Math.abs(delta) * 1000} ms ${delta < 0 ? "earlier" : "later"}`
              }
              text={(delta) =>
                `${delta < 0 ? "−" : "+"}${Math.abs(delta) * 1000}`
              }
              propsFor={(delta) =>
                trimRun.buttonProps(field, delta, `Trim ${name}`)
              }
            />
          </>
        ) : (
          String(edge === "in" ? clip.source_start : clip.source_end)
        )}
      </DefItem>
    );
  };

  const fadeDraft = (edge: "in" | "out") => {
    const saved = edge === "in" ? clip.fade_in_ms : clip.fade_out_ms;
    const draft = fadeDrafts.clipId === clip.id ? fadeDrafts[edge] : null;
    return draft && draft.baseline === saved ? draft.text : String(saved);
  };
  const setFadeDraft = (edge: "in" | "out", text: string) => {
    const baseline = edge === "in" ? clip.fade_in_ms : clip.fade_out_ms;
    setFadeDrafts((current) => ({
      ...(current.clipId === clip.id
        ? current
        : { clipId: clip.id, in: null, out: null }),
      [edge]: { baseline, text },
    }));
  };
  const fadeMax = (edge: "in" | "out") =>
    edgeFadeMaxMs(
      clipSec,
      trackFadeMaxMs,
      edge === "in" ? clip.fade_out_ms : clip.fade_in_ms,
    );
  const commitFade = async (edge: "in" | "out") => {
    if (!editable || !capKnown || clipMutationBusy || trimRun.running) return;
    const label = edge === "in" ? "Fade in" : "Fade out";
    const text = fadeDraft(edge).trim();
    const value = Number(text);
    const max = fadeMax(edge);
    if (!text || !Number.isInteger(value) || value < 0 || value > max) {
      setError(`${label} must be a whole number of ms from 0 to ${max}.`);
      return;
    }
    cancelClipPlacement();
    const saved = await run(async () => {
      try {
        await setClipFade(
          projectPath,
          clip.id,
          edge === "in" ? value : clip.fade_in_ms,
          edge === "out" ? value : clip.fade_out_ms,
          { fade_in_ms: clip.fade_in_ms, fade_out_ms: clip.fade_out_ms },
        );
        return true;
      } catch (failure) {
        const now = useDawStore.getState();
        if (
          now.projectPath !== projectPath ||
          now.projectEpoch !== projectEpoch
        ) {
          return undefined;
        }
        throw failure;
      }
    });
    if (saved) {
      setFadeDrafts({ clipId: clip.id, in: null, out: null });
    }
  };

  const renderFadeField = (edge: "in" | "out") => {
    const name = edge === "in" ? "Fade in" : "Fade out";
    const field: NudgeField = {
      kind: "fade",
      trackId: clip.track_id,
      clipId: clip.id,
      edge,
    };
    const [small, large] = NUDGE_KINDS.fade.steps;
    const deltas = [-large, -small, small, large];
    const saved = edge === "in" ? clip.fade_in_ms : clip.fade_out_ms;
    const dirty = fadeDraft(edge) !== String(saved);
    const unavailable = !capKnown || (edge === "in" ? cutIn : cutOut);
    const busyReason =
      clipMutationBusy || trimRun.running ? BUSY_REASON : undefined;
    return (
      <DefItem label={`${name} (ms)`} key={edge}>
        {editable ? (
          <>
            <FieldRow>
              <input
                type="number"
                min={0}
                max={fadeMax(edge)}
                step={1}
                inputMode="numeric"
                aria-label={`${name} ms`}
                value={fadeDraft(edge)}
                disabled={clipMutationBusy || trimRun.running || unavailable}
                onChange={(event) => setFadeDraft(edge, event.target.value)}
              />
              <Button
                disabledReason={
                  busyReason ??
                  (unavailable
                    ? FADE_AT_CUT_REASON
                    : dirty
                      ? undefined
                      : "Type a length to apply.")
                }
                onClick={() => void commitFade(edge)}
              >
                {`Apply ${name.toLowerCase()}`}
              </Button>
            </FieldRow>
            <NudgeButtons
              groupLabel={`Nudge ${name.toLowerCase()}`}
              deltas={deltas}
              unavailable={
                clipMutationBusy
                  ? BUSY_REASON
                  : unavailable
                    ? FADE_AT_CUT_REASON
                    : dirty
                      ? UNAPPLIED_VALUE_REASON
                      : undefined
              }
              onPointerDownCapture={() => {
                if (!clipMutationBusy && !dirty) cancelClipPlacement();
              }}
              label={(delta) =>
                `${Math.abs(delta)} ms ${delta < 0 ? "shorter" : "longer"}`
              }
              text={(delta) => `${delta < 0 ? "−" : "+"}${Math.abs(delta)}`}
              propsFor={(delta) => trimRun.buttonProps(field, delta, name)}
            />
            {edge === "out" && capKnown ? (
              <span className="ui-field-hint" role="status">
                {[fadeHint, `max ${fadeLimitMs} ms`]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </>
        ) : (
          `${saved} ms`
        )}
      </DefItem>
    );
  };
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
    cancelClipPlacement();
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
    cancelClipPlacement();
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
      error={error}
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
        <DefItem label="Timeline">
          {labels.start} to {labels.end}
          <ClipPlacementControls
            clipId={clip.id}
            busy={clipMutationBusy || trimRun.running}
          />
        </DefItem>
        <DefItem label="Automatic audio reduction">
          <Button
            disabledReason={
              clipMutationBusy || trimRun.running ? BUSY_REASON : undefined
            }
            onClick={() => {
              cancelClipPlacement();
              useDawStore.getState().setSelection({
                kind: "bleedAttenuation",
                id: clip.id,
                trackId: clip.track_id,
                regionKey: null,
              });
            }}
          >
            Inspect automatic audio reduction
          </Button>
        </DefItem>
        {renderTrimField("in")}
        {renderTrimField("out")}
        {renderFadeField("in")}
        {renderFadeField("out")}
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
                      disabledReason={
                        clipMutationBusy
                          ? BUSY_REASON
                          : joinLengthStr.trim() === ""
                            ? "Enter a transition length in milliseconds."
                            : undefined
                      }
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
        {playedMutes.length > 0 ? (
          <DefItem label="Mute regions">
            {playedMutes
              .map(
                (region) =>
                  `${region.start_s.toFixed(3)}–${region.end_s.toFixed(3)} s${region.gain_db ? ` (${region.gain_db} dB)` : ""}`,
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
              disabledReason={clipMutationBusy ? BUSY_REASON : undefined}
              onClick={() => void runDelete(false)}
            >
              {commandLabel("edit.delete", "short")}
            </Button>
            <Button
              variant="danger"
              disabledReason={clipMutationBusy ? BUSY_REASON : undefined}
              onClick={() => void runDelete(true)}
            >
              {commandLabel("edit.rippleDelete", "short")}
            </Button>
          </FieldRow>
          <p className="ui-field-hint">
            Delete leaves a gap. Ripple delete closes it on every dialogue
            track.
          </p>
        </section>
      ) : null}
    </ModifierInspector>
  );
}
