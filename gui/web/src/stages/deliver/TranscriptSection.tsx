import { useEffect, useRef } from "react";
import { formatBytes } from "../../models";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { Button, InlineError, ToggleButton } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import { DeliverSection } from "./DeliverSection";
import { type DeliverFiles, filesOfKinds } from "./deliverFiles";
import { ExportedFiles } from "./ExportedFiles";
import { TranscriptPreview } from "./TranscriptPreview";
import {
  exportLabel,
  filesSummary,
  TRANSCRIPT_ALL_CUT,
  TRANSCRIPT_EXPORT_RUNNING_REASON,
  TRANSCRIPT_FORMATS,
  TRANSCRIPT_WRITING_REASON,
  type TranscriptOptions,
  toggleFormat,
  transcriptBlocker,
  transcriptStaleOf,
} from "./transcriptLogic";

type Props = {
  options: TranscriptOptions;
  /** The files the export folder holds; the transcript ones show here. */
  files?: DeliverFiles;
  filesRunning?: boolean;
  state?: "ready" | "loading";
  /** The phone layout: fewer turns, full-width buttons. */
  compact?: boolean;
};

const COMPACT_TURNS = 4;

const GROUPS = [
  { id: "read", label: "Read" },
  { id: "captions", label: "Captions" },
] as const;

/** The edited transcript as text, Markdown and captions, written next to the audio. */
export function TranscriptSection({
  options,
  files: folder,
  filesRunning = false,
  state: pageState = "ready",
  compact = false,
}: Props) {
  const {
    preview,
    run,
    choices,
    onChoices,
    exportRunning = false,
    copyState = "idle",
    onExport,
    onCopy,
    onRetry,
    onPrepare,
    focusRequested = false,
    onFocused,
  } = options;
  const button = useRef<HTMLButtonElement>(null);
  const writing = run.phase === "writing";
  const written =
    folder?.files.filter((file) => file.kind === "transcript") ?? [];
  const stale = transcriptStaleOf(written, choices);
  const blocker = transcriptBlocker(preview, choices);
  const unavailable = writing
    ? TRANSCRIPT_WRITING_REASON
    : exportRunning
      ? (blocker ?? TRANSCRIPT_EXPORT_RUNNING_REASON)
      : blocker;
  const exportReason = useDisabledReasonNote(unavailable ?? undefined);

  const settled = pageState !== "loading" && preview.kind !== "loading";
  useEffect(() => {
    if (!focusRequested || !settled) return;
    const section = button.current?.closest("section");
    const target = button.current?.disabled
      ? section?.querySelector<HTMLElement>("button:not(:disabled)")
      : button.current;
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
    onFocused?.();
  }, [focusRequested, onFocused, settled]);

  if (pageState === "loading" || preview.kind === "loading") {
    return (
      <DeliverSection title="Transcript">
        <Skeleton layout="list" rows={4} onRetry={onRetry} />
      </DeliverSection>
    );
  }

  if (preview.kind === "none") {
    return (
      <DeliverSection title="Transcript">
        <StatusRow
          state="needs-you"
          title="Transcribe first"
          detail="The transcript appears here once the episode is transcribed."
          action={{ label: "Go to Prepare", onAction: onPrepare }}
        />
      </DeliverSection>
    );
  }

  if (preview.kind === "failed") {
    return (
      <DeliverSection title="Transcript">
        <StatusRow
          state="failed"
          title="Could not load the transcript"
          detail={preview.cause}
          action={
            onRetry ? { label: "Try again", onAction: onRetry } : undefined
          }
        />
      </DeliverSection>
    );
  }

  const label = exportLabel(choices.length, stale && run.phase !== "done");

  return (
    <DeliverSection title="Transcript">
      <p className="dv-note">
        Written from the edited episode, next to the audio.
      </p>
      {preview.kind === "allCut" ? (
        <p className="dv-note" role="status">
          {TRANSCRIPT_ALL_CUT}
        </p>
      ) : (
        <>
          <TranscriptPreview
            preview={
              compact
                ? {
                    ...preview.preview,
                    shown: preview.preview.shown.slice(0, COMPACT_TURNS),
                  }
                : preview.preview
            }
          />
          <div className="dv-tx-groups">
            {GROUPS.map((group) => (
              <div key={group.id} className="dv-field">
                <span className="dv-field-label">{group.label}</span>
                <div
                  className="dv-chips"
                  role="group"
                  aria-label={`${group.label} formats`}
                >
                  {TRANSCRIPT_FORMATS.filter((f) => f.group === group.id).map(
                    (format) => (
                      <ToggleButton
                        key={format.id}
                        pressed={choices.includes(format.id)}
                        onClick={() =>
                          onChoices(toggleFormat(choices, format.id))
                        }
                      >
                        {format.label}
                      </ToggleButton>
                    ),
                  )}
                </div>
              </div>
            ))}
          </div>
          {preview.preview.cueSample &&
          (choices.includes("srt") || choices.includes("vtt")) ? (
            <p className="dv-note sys-mono dv-tx-cue">
              {preview.preview.cueSample}
            </p>
          ) : null}
        </>
      )}

      {run.phase === "writing" ? (
        <StatusRow state="running" title="Writing" />
      ) : null}
      {run.phase === "failed" ? (
        <StatusRow state="failed" title="Export failed" detail={run.cause} />
      ) : null}
      {run.phase === "done" ? (
        <StatusRow
          state="done"
          title="Exported"
          detail={filesSummary(run.files, formatBytes)}
        />
      ) : null}
      {run.phase !== "done" && run.phase !== "writing" && stale ? (
        <StatusRow
          state="needs-you"
          title="Edited since export"
          detail="Export again to bring the files up to date."
        />
      ) : null}

      {preview.kind === "allCut" ? null : (
        <div className="dv-primary dv-tx-actions">
          <Button
            ref={button}
            disabledReason={unavailable ?? undefined}
            {...exportReason.describedBy}
            onClick={onExport}
          >
            {label}
          </Button>
          <Button onClick={onCopy}>
            {copyState === "copied"
              ? "Copied"
              : copyState === "blocked"
                ? "Copy blocked"
                : "Copy text"}
          </Button>
          {exportReason.note}
        </div>
      )}
      {copyState === "failed" ? (
        <InlineError message="Could not read the transcript to copy it." />
      ) : null}
      {copyState === "blocked" ? (
        <InlineError message="The browser blocked copying. Export the files and copy from there." />
      ) : null}

      {folder ? (
        <ExportedFiles
          {...filesOfKinds(folder, ["transcript"], filesRunning)}
        />
      ) : null}
    </DeliverSection>
  );
}
