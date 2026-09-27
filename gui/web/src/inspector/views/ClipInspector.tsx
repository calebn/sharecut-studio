import { useEffect, useState } from "react";
import { setClipFade, setClipJoin } from "../../api";
import { execute } from "../../commands/execute";
import { clampClipFades, maxFadeMs } from "../../edit/fadeLimits";
import {
  cutFadeHint,
  isCutJoin,
  JOIN_MODE_OPTIONS,
  joinModeLabel,
  joinRenderNote,
} from "../../edit/joinRender";
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
import { formatTime } from "../../utils/time";
import { ModifierInspector } from "../ModifierInspector";

export function ClipInspector({ clip }: { clip: ClipRow }) {
  const { projectPath, guestMode, shareCapabilities } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const { busy, error, setError, run } = useProjectMutation();
  const [fadeInStr, setFadeInStr] = useState(String(clip.fade_in_ms));
  const [fadeOutStr, setFadeOutStr] = useState(String(clip.fade_out_ms));
  const [joinLengthStr, setJoinLengthStr] = useState("");
  const [clamped, setClamped] = useState<{
    inMs: number;
    outMs: number;
  } | null>(null);

  useEffect(() => {
    setFadeInStr(String(clip.fade_in_ms));
    setFadeOutStr(String(clip.fade_out_ms));
    setError(null);
  }, [clip.id, clip.fade_in_ms, clip.fade_out_ms, setError]);

  useEffect(() => {
    setClamped(null);
    setJoinLengthStr("");
  }, [clip.id]);

  // undefined: the clip's track is not in the view yet (cap unknown);
  // null: the track is uncapped.
  const trackFadeMaxMs = useDawStore((s) => {
    const track = s.project?.tracks.find((t) => t.id === clip.track_id);
    return track === undefined ? undefined : (track.fade_max_ms ?? null);
  });
  const capKnown = trackFadeMaxMs !== undefined;
  const clipSec = clip.source_end - clip.source_start;
  const fadeLimitMs = maxFadeMs(clipSec, trackFadeMaxMs);
  // Shown while the saved lengths are the ones it describes.
  const clampNotice =
    clamped &&
    clamped.inMs === clip.fade_in_ms &&
    clamped.outMs === clip.fade_out_ms
      ? `Clamped to ${clamped.inMs} ms in / ${clamped.outMs} ms out`
      : null;

  const editable = canApplyPass12(projectPath, guestMode, shareCapabilities);
  const canStructural = canSuggestStructural(
    projectPath,
    guestMode,
    shareCapabilities,
  );

  const commitFades = async () => {
    const fadeIn = Number.parseInt(fadeInStr, 10);
    const fadeOut = Number.parseInt(fadeOutStr, 10);
    if (
      !Number.isFinite(fadeIn) ||
      !Number.isFinite(fadeOut) ||
      fadeIn < 0 ||
      fadeOut < 0
    ) {
      setError("Fade times must be non-negative integers (ms)");
      return;
    }
    if (!capKnown) {
      return;
    }
    const next = clampClipFades(fadeIn, fadeOut, clipSec, trackFadeMaxMs);
    setClamped(null);
    const saved = await run(async () => {
      await setClipFade(projectPath, clip.id, next.inMs, next.outMs);
      return true;
    });
    if (!saved) {
      // Keep the typed values next to the error; nothing was stored.
      return;
    }
    // Show what the server stored: the reset effect only reruns when the
    // clip's committed lengths change.
    setFadeInStr(String(next.inMs));
    setFadeOutStr(String(next.outMs));
    if (next.inMs !== fadeIn || next.outMs !== fadeOut) {
      setClamped(next);
    }
  };

  const leftClipId = clip.join_left_clip_id ?? null;
  // Render ignores the fades at a cut join: this clip's fade-in when its
  // incoming join is a cut, its fade-out when the next clip's join is.
  const cutIn = isCutJoin(clip);
  const cutOut = useDawStore((s) =>
    Object.values(s.project?.clips?.tracks ?? {}).some((rows) =>
      rows.some((c) => c.join_left_clip_id === clip.id && isCutJoin(c)),
    ),
  );
  const fadeHint = cutFadeHint(cutIn, cutOut);
  const joinNote = joinRenderNote(clip);

  // Empty length lets the server pick the mode's default; a typed length is used once.
  const commitJoin = async (mode: string, lengthStr: string) => {
    if (leftClipId === null) {
      return;
    }
    const trimmed = lengthStr.trim();
    const length = trimmed === "" ? null : Number(trimmed);
    if (length !== null && !(Number.isInteger(length) && length >= 0)) {
      setError("Join length must be a non-negative integer (ms)");
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
    await run(async () => {
      const result = await execute(
        ripple ? "edit.rippleDelete" : "edit.delete",
        { clipId: clip.id },
        { skipWhen: true },
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

  const primaryActions = [];
  if (canStructural) {
    primaryActions.push(
      {
        label: "Delete",
        variant: "danger" as const,
        disabled: busy,
        onClick: () => void runDelete(false),
      },
      {
        label: "Ripple delete",
        variant: "danger" as const,
        disabled: busy,
        onClick: () => void runDelete(true),
      },
    );
  }

  return (
    <ModifierInspector
      badge="Clip"
      title="Clip"
      subtitle={clip.id}
      primaryActions={primaryActions.length ? primaryActions : undefined}
      error={error}
      footer={
        <InspectorSeekFooter
          seekSec={joinSec}
          playStart={joinSec}
          playEnd={joinSec}
          padSec={0.75}
          seekLabel="Seek join"
          playLabel="Play across join"
          actionVariant="default"
        />
      }
    >
      <DefinitionList>
        <DefItem label="ID">{clip.id}</DefItem>
        <DefItem label="Timeline">
          {formatTime(clip.timeline_start)} – {formatTime(clip.timeline_end)}
        </DefItem>
        <DefItem label="Source">
          {clip.source_start.toFixed(3)} – {clip.source_end.toFixed(3)} s
        </DefItem>
        <DefItem label="Fades">
          {editable ? (
            <FieldRow>
              <input
                type="number"
                min={0}
                max={capKnown ? fadeLimitMs : undefined}
                step={1}
                value={fadeInStr}
                disabled={busy || cutIn}
                aria-label="Fade in ms"
                onChange={(e) => setFadeInStr(e.target.value)}
              />
              <span>ms in /</span>
              <input
                type="number"
                min={0}
                max={capKnown ? fadeLimitMs : undefined}
                step={1}
                value={fadeOutStr}
                disabled={busy || cutOut}
                aria-label="Fade out ms"
                onChange={(e) => setFadeOutStr(e.target.value)}
              />
              <span>ms out</span>
              {capKnown ? (
                <span className="ui-field-hint" role="status">
                  {fadeHint ?? clampNotice ?? `max ${fadeLimitMs} ms`}
                </span>
              ) : null}
              <Button
                disabled={busy || !capKnown || (cutIn && cutOut)}
                onClick={() => void commitFades()}
              >
                Apply fades
              </Button>
            </FieldRow>
          ) : (
            <>
              in {clip.fade_in_ms} ms / out {clip.fade_out_ms} ms
            </>
          )}
        </DefItem>
        {leftClipId !== null ? (
          <DefItem label="Join">
            {editable ? (
              <FieldRow>
                <select
                  value={clip.join_in_mode}
                  disabled={busy}
                  aria-label="Join mode"
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
                      min={0}
                      step={1}
                      value={joinLengthStr}
                      placeholder="default"
                      disabled={busy}
                      aria-label="Join length ms"
                      onChange={(e) => setJoinLengthStr(e.target.value)}
                    />
                    <span>ms</span>
                    <Button
                      disabled={busy || joinLengthStr.trim() === ""}
                      onClick={() =>
                        void commitJoin(clip.join_in_mode, joinLengthStr)
                      }
                    >
                      Apply length
                    </Button>
                  </>
                )}
              </FieldRow>
            ) : (
              joinModeLabel(clip.join_in_mode)
            )}
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
        {(clip.mute_regions ?? []).length > 0 ? (
          <DefItem label="Mute regions">
            {(clip.mute_regions ?? [])
              .map(
                (region) =>
                  `${region.start_s.toFixed(3)}–${region.end_s.toFixed(3)} s`,
              )
              .join(", ")}
          </DefItem>
        ) : null}
      </DefinitionList>
    </ModifierInspector>
  );
}
