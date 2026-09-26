import { useEffect, useState } from "react";
import { setClipFade, setJoinMode } from "../../api";
import { execute } from "../../commands/execute";
import { clampFadeMs, maxFadeMs } from "../../edit/fadeLimits";
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

const JOIN_MODES = ["fade", "crossfade", "cut"] as const;

export function ClipInspector({ clip }: { clip: ClipRow }) {
  const { projectPath, guestMode, shareCapabilities } = useDaw((s) => ({
    projectPath: s.projectPath,
    guestMode: s.guestMode,
    shareCapabilities: s.shareCapabilities,
  }));
  const { busy, error, setError, run } = useProjectMutation();
  const [fadeInStr, setFadeInStr] = useState(String(clip.fade_in_ms));
  const [fadeOutStr, setFadeOutStr] = useState(String(clip.fade_out_ms));

  useEffect(() => {
    setFadeInStr(String(clip.fade_in_ms));
    setFadeOutStr(String(clip.fade_out_ms));
    setError(null);
  }, [clip.id, clip.fade_in_ms, clip.fade_out_ms, setError]);

  const trackFadeMaxMs = useDawStore(
    (s) =>
      s.project?.tracks.find((t) => t.id === clip.track_id)?.fade_max_ms ??
      null,
  );
  const fadeLimitMs = maxFadeMs(
    clip.source_end - clip.source_start,
    trackFadeMaxMs,
  );

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
    const cappedIn = clampFadeMs(fadeIn, fadeLimitMs);
    const cappedOut = clampFadeMs(fadeOut, fadeLimitMs);
    setFadeInStr(String(cappedIn));
    setFadeOutStr(String(cappedOut));
    await run(async () => {
      await setClipFade(projectPath, clip.id, cappedIn, cappedOut);
    });
  };

  const commitJoinMode = async (mode: string) => {
    if (mode === clip.join_in_mode) {
      return;
    }
    await run(async () => {
      await setJoinMode(projectPath, clip.id, mode);
    });
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
                max={fadeLimitMs}
                step={1}
                value={fadeInStr}
                disabled={busy}
                aria-label="Fade in ms"
                onChange={(e) => setFadeInStr(e.target.value)}
              />
              <span>ms in /</span>
              <input
                type="number"
                min={0}
                max={fadeLimitMs}
                step={1}
                value={fadeOutStr}
                disabled={busy}
                aria-label="Fade out ms"
                onChange={(e) => setFadeOutStr(e.target.value)}
              />
              <span>ms out</span>
              <span className="ui-field-hint">max {fadeLimitMs} ms</span>
              <Button disabled={busy} onClick={() => void commitFades()}>
                Apply fades
              </Button>
            </FieldRow>
          ) : (
            <>
              in {clip.fade_in_ms} ms / out {clip.fade_out_ms} ms
            </>
          )}
        </DefItem>
        <DefItem label="Join">
          {editable ? (
            <select
              value={clip.join_in_mode}
              disabled={busy}
              aria-label="Join mode"
              onChange={(e) => void commitJoinMode(e.target.value)}
            >
              {JOIN_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            clip.join_in_mode
          )}
        </DefItem>
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
