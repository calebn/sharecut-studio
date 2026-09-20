import { useEffect, useRef, useState } from "react";
import { followExportJob, startBounceJob } from "../api";
import { seedStudioJob } from "../state/seedStudioJob";
import { useDaw } from "../state/useDaw";
import { Button, Dialog, InlineError } from "../ui";

type SourceMode = "entire" | "selected" | "soloed";

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
    announceStatus,
  } = useDaw();
  const [source, setSource] = useState<SourceMode>("entire");
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
      const job = await startBounceJob(projectPath, {
        track_ids: trackIds,
        start_s: useRegion && region ? region.start_sec : null,
        end_s: useRegion && region ? region.end_sec : null,
        formats,
      });
      seedStudioJob(job);
      const paths = await followExportJob(job.id, "Bounce failed", {
        signal: ac.signal,
      });
      announceStatus(`Bounced ${paths.length} file(s) to export/bounces/`);
      setBounceDialogOpen(false);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
      }
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={bounceDialogOpen && !!project}
      onClose={() => setBounceDialogOpen(false)}
      title="Bounce…"
      panelClassName="bounce-dialog-panel"
    >
      <fieldset className="bounce-dialog-fieldset">
        <legend>Source</legend>
        <label>
          <input
            type="radio"
            name="bounce-source"
            checked={source === "entire"}
            onChange={() => setSource("entire")}
          />
          Entire mix
        </label>
        <label>
          <input
            type="radio"
            name="bounce-source"
            checked={source === "selected"}
            onChange={() => setSource("selected")}
          />
          Selected tracks ({selectedCount})
        </label>
        <label>
          <input
            type="radio"
            name="bounce-source"
            checked={source === "soloed"}
            onChange={() => setSource("soloed")}
          />
          Soloed tracks ({soloCount})
        </label>
      </fieldset>
      <label className="bounce-dialog-check">
        <input
          type="checkbox"
          checked={useRegion}
          disabled={!region}
          onChange={(e) => setUseRegion(e.target.checked)}
        />
        Limit to session region
        {!region ? " (no region set)" : ""}
      </label>
      <label className="bounce-dialog-check">
        <input
          type="checkbox"
          checked={includeMp3}
          onChange={(e) => setIncludeMp3(e.target.checked)}
        />
        Also write MP3
      </label>
      <InlineError message={error} />
      <div className="bounce-dialog-actions">
        <Button
          variant="primary"
          type="button"
          disabled={busy}
          onClick={() => void onBounce()}
        >
          {busy ? "Bouncing…" : "Bounce"}
        </Button>
      </div>
    </Dialog>
  );
}
