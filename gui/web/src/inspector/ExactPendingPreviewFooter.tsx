import { useEffect, useRef, useState } from "react";
import { hostFetch } from "../api/documentTransport";
import { rangeIsCurrent, rangeTargetsEqual } from "../edit/rangeSelection";
import {
  hasShareCapability,
  isShareProjectKey,
  reviewApiBase,
  shareTokenFromKey,
} from "../shareMode";
import { useDawStore } from "../state/dawStore";
import type { PendingEditView } from "../types/project";
import { InspectorSeekFooterView } from "../ui/InspectorSeekFooterView";
import { errorMessage, readApiError } from "../utils/apiError";
import {
  DEFAULT_AB_GAP_SEC,
  type PreviewMode,
  paddedAuditionWindow,
} from "../utils/playRange";

export function ExactPendingPreviewFooter({
  edit,
  projectPath,
  mode,
  onModeChange,
  onError,
}: {
  edit: PendingEditView;
  projectPath: string;
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const guestMode = useDawStore((state) => state.guestMode);
  const capabilities = useDawStore((state) => state.shareCapabilities);
  const canPlay =
    (!isShareProjectKey(projectPath) && guestMode === null) ||
    hasShareCapability(capabilities, "play");
  const resource = useRef<{ controller: AbortController; url?: string } | null>(
    null,
  );
  const ownerId = `pending:${edit.id}`;
  useEffect(
    () => () => {
      resource.current?.controller.abort();
      useDawStore.getState().releaseSourcePreview(ownerId);
      if (resource.current?.url) URL.revokeObjectURL(resource.current.url);
    },
    [ownerId],
  );
  const target = edit.exact_range;
  if (!target) return null;
  const start = target.intervals[0].start;
  const end = target.intervals.at(-1)!.end;
  const play = async () => {
    const captured = useDawStore.getState();
    if (
      ((!isShareProjectKey(projectPath) && captured.guestMode !== null) ||
        isShareProjectKey(projectPath)) &&
      !hasShareCapability(captured.shareCapabilities, "play")
    )
      return;
    if (
      captured.projectPath !== projectPath ||
      !captured.project ||
      !rangeIsCurrent(captured.project, target)
    )
      return;
    const mixKey = JSON.stringify([
      captured.project.tracks,
      captured.project.clips,
      captured.project.effects_by_track,
      captured.project.envelopes,
    ]);
    const epoch = captured.projectEpoch;
    resource.current?.controller.abort();
    if (resource.current?.url) {
      captured.releaseSourcePreview(ownerId);
      URL.revokeObjectURL(resource.current.url);
    }
    const request = {
      controller: new AbortController(),
      url: undefined as string | undefined,
    };
    resource.current = request;
    setBusy(true);
    onError(null);
    try {
      const query = new URLSearchParams({ edit_id: edit.id, mode });
      const guest = isShareProjectKey(projectPath);
      const endpoint = guest
        ? `${reviewApiBase(shareTokenFromKey(projectPath)!)}/daw/pending-preview`
        : "/api/pending-preview";
      if (!guest) query.set("path", projectPath);
      const response = await (guest ? fetch : hostFetch)(
        `${endpoint}?${query}`,
        { signal: request.controller.signal },
      );
      if (!response.ok) throw new Error(await readApiError(response));
      const blob = await response.blob();
      const live = useDawStore.getState();
      const pending = live.project?.pending_edits.find(
        (item) => item.id === edit.id,
      );
      if (
        request.controller.signal.aborted ||
        live.projectPath !== projectPath ||
        live.projectEpoch !== epoch ||
        live.guestMode !== captured.guestMode ||
        !live.project ||
        pending?.can_skip === false ||
        !rangeIsCurrent(live.project, target) ||
        JSON.stringify([
          live.project.tracks,
          live.project.clips,
          live.project.effects_by_track,
          live.project.envelopes,
        ]) !== mixKey ||
        ((isShareProjectKey(live.projectPath) || live.guestMode !== null) &&
          !hasShareCapability(live.shareCapabilities, "play")) ||
        !pending?.exact_range ||
        !rangeTargetsEqual(pending.exact_range, target)
      )
        return;
      request.url = URL.createObjectURL(blob);
      const window = paddedAuditionWindow(start, end);
      const duration = window.end - window.start;
      live.beginSourcePreview({
        ownerId,
        media: { kind: "rendered", url: request.url },
        startSec: 0,
        endSec: mode === "ab" ? duration * 2 + DEFAULT_AB_GAP_SEC : duration,
      });
    } catch (error) {
      if (!request.controller.signal.aborted) onError(errorMessage(error));
    } finally {
      if (!request.controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <InspectorSeekFooterView
      onSeek={() => useDawStore.getState().setPlayheadSec(start)}
      onPlay={() => void play()}
      previewMode={mode}
      onPreviewModeChange={onModeChange}
      playDisabled={busy || !canPlay || edit.can_skip === false}
      playDisabledReason={
        busy
          ? "Preparing full mix preview"
          : !canPlay
            ? "This share cannot play audio"
            : (edit.skip_reason ?? undefined)
      }
      suggestDisabled={edit.can_skip === false}
      suggestDisabledReason={edit.skip_reason}
    />
  );
}
