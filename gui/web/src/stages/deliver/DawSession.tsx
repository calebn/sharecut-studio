import { useEffect, useId, useRef, useState } from "react";
import { cancelPipelineRun, JobCancelledError } from "../../api";
import { type DawFormat, loadDawFormats } from "../../api/dawExport";
import { useNowSec } from "../../hooks/useNowSec";
import {
  dawStartPending,
  exportDawSession,
} from "../../stage/hosts/runDawExport";
import { useDawStore } from "../../state/dawStore";
import { StatusRow } from "../../system/StatusRow";
import { Button } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import { errorMessage } from "../../utils/apiError";
import { isPipelineRunning } from "../../utils/pipeline";
import {
  pipelineProgressPercent,
  pipelineUnitsLabel,
  staleUpdateLabel,
} from "../../utils/pipelineProgress";
import { formatTimeShort } from "../../utils/time";
import { DeliverSection } from "./DeliverSection";
import { type DeliverFiles, filesOfKinds } from "./deliverFiles";
import { ExportedFiles } from "./ExportedFiles";

const destinations = {
  rpp: {
    name: "REAPER (RPP)",
    help: "Opened, edited and played in REAPER 7.86 on Linux. Fade lengths use linear curves. Extract the ZIP and keep the media folder beside the RPP.",
  },
  aaf: {
    name: "AAF",
    help: "Imported, edited and played in Logic Pro 12.4 and Ardour 8.12. Pro Tools import is unverified. Extract the AAF from the ZIP. Audio is embedded. Clip fades, gain and mute are omitted.",
  },
  sesx: {
    name: "Adobe Audition (SESX)",
    help: "An independent reader checked clip timing and media references. Opening and playing the session in Audition is unverified. Extract the ZIP and keep the media folder beside the SESX.",
  },
} satisfies Record<DawFormat, { name: string; help: string }>;

type Run =
  | { phase: "idle" | "running" }
  | { phase: "failed"; message: string }
  | { phase: "done"; id: string };
type Props = {
  projectPath: string;
  files: DeliverFiles;
  reload: () => void;
  fileLoad: "ready" | "loading" | "error";
  saveBlocker?: string;
  filesRunning: boolean;
};

export function DawSession({
  projectPath,
  files,
  reload,
  fileLoad,
  saveBlocker,
  filesRunning,
}: Props) {
  const field = useId();
  const [format, setFormat] = useState<DawFormat>();
  const [formats, setFormats] =
    useState<Awaited<ReturnType<typeof loadDawFormats>>>();
  const [readFailed, setReadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const checking = format !== undefined;
  useEffect(() => {
    if (!checking) return;
    const watch = new AbortController();
    loadDawFormats(projectPath, watch.signal).then(
      (available) => {
        if (!watch.signal.aborted) setFormats(available);
      },
      () => {
        if (!watch.signal.aborted) setReadFailed(true);
      },
    );
    return () => watch.abort();
  }, [projectPath, checking, attempt]);
  const activity = useDawStore((s) => s.activityJob);
  const starting = useDawStore(dawStartPending);
  const job =
    activity?.kind === "daw_export" && activity.project_path === projectPath
      ? activity
      : null;
  const runningJob = job && isPipelineRunning(job) ? job : null;
  const [stopping, setStopping] = useState<string>();
  const busy = run.phase === "running" || starting || runningJob !== null;
  const now = useNowSec(busy);
  const cancelling = runningJob && stopping === runningJob.id;
  const detail = [
    cancelling
      ? "Cancelling. Session audio preparation may need to finish first."
      : (runningJob?.message ?? "Starting export…"),
    pipelineUnitsLabel(runningJob),
    runningJob && `Elapsed ${formatTimeShort(runningJob.elapsed_sec)}`,
    staleUpdateLabel(runningJob?.last_progress_at, now),
  ]
    .filter(Boolean)
    .join(" · ");
  const percent = pipelineProgressPercent(runningJob);
  const terminal = job && !runningJob ? job.id : null;
  useEffect(() => {
    if (terminal) reload();
  }, [terminal, reload]);
  async function cancel() {
    if (!runningJob || cancelling) return;
    setStopping(runningJob.id);
    try {
      await cancelPipelineRun(runningJob.id);
    } catch (error) {
      setStopping(undefined);
      setRun({ phase: "failed", message: errorMessage(error) });
    }
  }
  const blocker = busy
    ? "Exporting the saved timeline…"
    : !format
      ? "Choose a DAW format."
      : (saveBlocker ??
        (filesRunning ? "An audio export is running." : undefined) ??
        (!formats
          ? readFailed
            ? "Could not check DAW formats."
            : "Checking available formats…"
          : (formats[format] ?? undefined)));
  const reason = useDisabledReasonNote(blocker, "dv-note");
  async function start() {
    if (!format || blocker) return;
    setRun({ phase: "running" });
    try {
      const id = await exportDawSession(projectPath, format);
      if (mounted.current) setRun({ phase: "done", id });
    } catch (error) {
      if (mounted.current)
        setRun(
          error instanceof JobCancelledError
            ? { phase: "idle" }
            : { phase: "failed", message: errorMessage(error) },
        );
    } finally {
      if (mounted.current) reload();
    }
  }
  const rows = filesOfKinds(files, ["daw"], filesRunning);
  const missing =
    run.phase === "done" && !rows.files.some((file) => file.id === run.id);
  return (
    <DeliverSection title="Editable DAW session">
      <p className="dv-note">
        Experimental. Transfer the saved tracks and clips to another editor.
        Transcripts, comments, undo history and effects stay in ShareCut. For
        the rendered mix, use WAV in Episode file.
      </p>
      <div className="dv-field">
        <label className="dv-field-label" htmlFor={field}>
          DAW format
        </label>
        <select
          id={field}
          className="ui-control"
          value={format ?? ""}
          disabled={busy}
          onChange={(event) => {
            const value = event.target.value;
            setFormat(
              value === "rpp" || value === "aaf" || value === "sesx"
                ? value
                : undefined,
            );
            setRun({ phase: "idle" });
          }}
        >
          <option value="">Choose a format</option>
          {Object.entries(destinations).map(([value, item]) => (
            <option key={value} value={value}>
              {item.name}
            </option>
          ))}
        </select>
      </div>
      {format ? <p className="dv-note">{destinations[format].help}</p> : null}
      <div className="dv-primary">
        <Button
          disabledReason={blocker}
          {...reason.describedBy}
          onClick={() => void start()}
        >
          Export DAW session
        </Button>
        {reason.note}
        {readFailed && !formats ? (
          <Button
            onClick={() => {
              setReadFailed(false);
              setAttempt(attempt + 1);
            }}
          >
            Check formats again
          </Button>
        ) : null}
      </div>
      {busy ? (
        <StatusRow
          state="running"
          title="Exporting DAW session"
          detail={detail}
          progress={percent === null ? undefined : percent / 100}
          action={{
            label: "Cancel",
            onAction: () => void cancel(),
            disabledReason: !runningJob
              ? "The export is still starting."
              : cancelling
                ? "Already cancelling."
                : undefined,
          }}
        />
      ) : null}
      {!busy && job?.status === "cancelled" ? (
        <p className="dv-note">DAW export cancelled.</p>
      ) : null}
      {run.phase === "failed" ? (
        <p className="dv-note" role="alert">
          {run.message}
        </p>
      ) : null}
      {run.phase === "done" ? (
        <p className="dv-note">
          {missing
            ? fileLoad === "loading"
              ? "Finding the exported session…"
              : "Could not find the exported session."
            : "DAW session exported."}
        </p>
      ) : null}
      {missing && fileLoad !== "loading" ? (
        <Button onClick={reload}>Refresh files</Button>
      ) : null}
      <ExportedFiles
        {...rows}
        largeFileNote="The session contains the source audio. Use Wi-Fi to download it."
      />
    </DeliverSection>
  );
}
