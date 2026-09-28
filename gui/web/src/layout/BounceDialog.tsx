import { useEffect, useRef, useState } from "react";
import { startBounceJob } from "../api";
import { runAnnouncedJob } from "../state/runAnnouncedJob";
import { useDaw } from "../state/useDaw";
import { errorMessage, isAbortError } from "../utils/apiError";
import { BounceDialogView, type BounceSourceMode } from "./BounceDialogView";

/**
 * Host bounce dialog — same params as MCP ``bounce_audio`` / CLI ``pipeline bounce``.
 */
export function BounceDialog() {
  const {
    bounceDialogOpen,
    setBounceDialogOpen,
    project,
    projectPath,
    selectedTrackIds,
    soloTracks,
    sessionRegion,
  } = useDaw((s) => ({
    bounceDialogOpen: s.bounceDialogOpen,
    setBounceDialogOpen: s.setBounceDialogOpen,
    project: s.project,
    projectPath: s.projectPath,
    selectedTrackIds: s.selectedTrackIds,
    soloTracks: s.soloTracks,
    sessionRegion: s.sessionRegion,
  }));
  const [source, setSource] = useState<BounceSourceMode>("entire");
  const [includeMp3, setIncludeMp3] = useState(false);
  const [useRegion, setUseRegion] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!bounceDialogOpen) {
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    setSource("entire");
    setIncludeMp3(false);
    setUseRegion(false);
    setError(null);
    setBusy(false);
  }, [bounceDialogOpen]);

  const selectedCount = selectedTrackIds.length;
  const soloCount = Object.values(soloTracks).filter(Boolean).length;
  const region = sessionRegion;

  async function onBounce() {
    let trackIds: string[] | null = null;
    if (source === "selected") {
      trackIds = [...selectedTrackIds];
      if (trackIds.length === 0) {
        setError("Select one or more tracks first");
        return;
      }
    } else if (source === "soloed") {
      trackIds = Object.entries(soloTracks)
        .filter(([, on]) => on)
        .map(([id]) => id);
      if (trackIds.length === 0) {
        setError("Solo one or more tracks first");
        return;
      }
    }
    const formats = includeMp3 ? ["wav", "mp3"] : ["wav"];
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError(null);
    try {
      await runAnnouncedJob(
        () =>
          startBounceJob(projectPath, {
            track_ids: trackIds,
            start_s: useRegion && region ? region.start_sec : null,
            end_s: useRegion && region ? region.end_sec : null,
            formats,
          }),
        {
          failLabel: "Bounce failed",
          resultCopy: (paths) =>
            `Bounced ${paths.length} file(s) to export/bounces/`,
          signal: ac.signal,
        },
      );
      setBounceDialogOpen(false);
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      setError(errorMessage(err));
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
      }
      setBusy(false);
    }
  }

  return (
    <BounceDialogView
      open={bounceDialogOpen && !!project}
      onClose={() => setBounceDialogOpen(false)}
      source={source}
      onSourceChange={setSource}
      selectedCount={selectedCount}
      soloCount={soloCount}
      hasRegion={region != null}
      useRegion={useRegion}
      onUseRegionChange={setUseRegion}
      includeMp3={includeMp3}
      onIncludeMp3Change={setIncludeMp3}
      busy={busy}
      error={error}
      onBounce={() => void onBounce()}
    />
  );
}
