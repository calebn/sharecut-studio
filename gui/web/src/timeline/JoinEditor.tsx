import { memo, useMemo } from "react";
import { joinVisual } from "../edit/joinRender";
import { useDaw } from "../state/useDaw";
import type { ClipRow } from "../types/project";
import type { MediaRef } from "../waveform/types";
import { JoinBlend, type JoinWaveSides } from "./JoinBlend";

interface JoinEditorProps {
  left: ClipRow;
  right: ClipRow;
  zoomPxPerSec: number;
  leftRef?: MediaRef;
  rightRef?: MediaRef;
  role?: string;
  gainDb?: number;
}

function JoinEditorLive({
  left,
  right,
  zoomPxPerSec,
  leftRef,
  rightRef,
  role,
  gainDb,
}: JoinEditorProps) {
  const draft = useDaw((s) =>
    s.joinDraft?.id === right.id ? s.joinDraft : null,
  );
  const shown = draft ?? right;
  const waves = useMemo<JoinWaveSides | undefined>(
    () =>
      leftRef && rightRef && role !== undefined && gainDb !== undefined
        ? { leftRef, rightRef, role, gainDb }
        : undefined,
    [leftRef, rightRef, role, gainDb],
  );
  return (
    <JoinBlend
      visual={joinVisual(shown, zoomPxPerSec)}
      left={left}
      right={right}
      waves={shown.join_crossfade_blocked ? undefined : waves}
      zoomPxPerSec={zoomPxPerSec}
    />
  );
}

export const JoinEditor = memo(JoinEditorLive);
