import { useEffect, useId, useRef } from "react";
import { formatBytes, ModelGateHint, ModelGatePanel } from "../../models";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { TimeField } from "../../system/TimeField";
import { Button, InlineError, SegmentedControl, ToggleButton } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import {
  clampPart,
  type DeliverEnv,
  type EpisodeSettings,
  type ExportFile,
  type ExportOptions,
  type ExportState,
  estimateBytes,
  exportBlocker,
  FORMATS,
  type FormatId,
  formatClock,
  LOUDNESS,
  parseClock,
  partSeconds,
  primaryAction,
} from "./deliverLogic";
import { ExportButton } from "./ExportButton";
import type { TranscriptPreviewState } from "./transcriptLogic";

function transcriptNote(
  kind: TranscriptPreviewState["kind"] | undefined,
): string | null {
  if (kind === "ready")
    return "The transcript is written with every export. Choose more files in Transcript below.";
  if (kind === "none") return null;
  return "Captions and transcript are written with every export.";
}

type Props = {
  settings: EpisodeSettings;
  /** Episode length in seconds. */
  total: number;
  /** Where files go, as a folder name. */
  saveTo?: string;
  exportState: ExportState;
  env: DeliverEnv;
  state?: "ready" | "loading";
  /** The Export button lives in the phone dock instead of here. */
  dock?: boolean;
  options?: ExportOptions;
  transcriptKind?: TranscriptPreviewState["kind"];
  onSettings: (next: EpisodeSettings) => void;
  /** Without it the Saves to line is not shown. */
  onChangeFolder?: () => void;
  onExport: () => void;
  onGetModel?: () => void;
  onCancel?: () => void;
  onReveal?: (file?: ExportFile) => void;
  onDownload?: (file?: ExportFile) => void;
};

export function EpisodeFile({
  settings,
  total,
  saveTo = "",
  exportState,
  env,
  state = "ready",
  dock = false,
  options = {},
  transcriptKind,
  onSettings,
  onChangeFolder,
  onExport,
  onGetModel,
  onCancel,
  onReveal,
  onDownload,
}: Props) {
  const note = transcriptNote(transcriptKind);
  const wavNote = useId();
  const gatePanel = useRef<HTMLDivElement>(null);
  const runningBlock = useRef<HTMLDivElement>(null);
  const running = exportState.phase === "running";
  const wasRunning = useRef(running);
  useEffect(() => {
    if (dock && running && !wasRunning.current)
      runningBlock.current?.scrollIntoView?.({ block: "center" });
    wasRunning.current = running;
  }, [running, dock]);
  const askPhase =
    exportState.phase === "needs-model" ? options.gate?.prompt?.phase : null;
  useEffect(() => {
    if (!askPhase) return;
    const first = gatePanel.current?.querySelector("button");
    first?.scrollIntoView?.({ block: "center" });
    first?.focus();
  }, [askPhase]);
  if (state === "loading") {
    return (
      <DeliverSection title="Episode file">
        <Skeleton layout="list" rows={4} />
      </DeliverSection>
    );
  }
  const seconds = partSeconds(settings.part, total);
  const formats = options.formats ?? FORMATS;
  const blocker = exportBlocker(settings, exportState, options);
  const action = primaryAction(exportState, env);
  const toggleFormat = (id: FormatId) =>
    onSettings({
      ...settings,
      formats: settings.formats.includes(id)
        ? settings.formats.filter((f) => f !== id)
        : [...settings.formats, id],
    });
  const files =
    exportState.phase === "done" ||
    exportState.phase === "stale" ||
    exportState.phase === "cancelled"
      ? exportState.files
      : [];

  return (
    <DeliverSection title="Episode file">
      {options.loading ? (
        <p className="dv-note" role="status">
          Loading export settings…
        </p>
      ) : (
        <div className="dv-chips" role="group" aria-label="Formats">
          {options.wavAlwaysWritten ? (
            <ToggleButton
              pressed
              disabledReason="Always written."
              aria-describedby={wavNote}
            >
              WAV
            </ToggleButton>
          ) : null}
          {formats.map((format) => (
            <ToggleButton
              key={format.id}
              pressed={settings.formats.includes(format.id)}
              onClick={() => toggleFormat(format.id)}
            >
              {format.label}
              <span className="sys-mono dv-chip-size">
                {formatBytes(estimateBytes(format.id, seconds, formats))}
              </span>
            </ToggleButton>
          ))}
        </div>
      )}
      {options.wavAlwaysWritten && !options.loading ? (
        <p id={wavNote} className="dv-note">
          WAV is the lossless master and is always written. Turn it off in the
          Pipeline tab.
        </p>
      ) : null}
      {options.settingsError ? (
        <InlineError
          message={`Export settings did not load: ${options.settingsError}. Export uses this project's saved formats.`}
        />
      ) : null}
      {note ? <p className="dv-note">{note}</p> : null}

      {options.loudnessNote ? (
        <p className="dv-note">
          {options.loudnessNote} Change the target in the Pipeline tab.
        </p>
      ) : options.loudness === false ? null : (
        <div className="dv-field">
          <span className="dv-field-label">Loudness</span>
          <SegmentedControl label="Loudness">
            {LOUDNESS.map((entry) => (
              <ToggleButton
                key={entry.id}
                quiet
                pressed={settings.loudness === entry.id}
                onClick={() => onSettings({ ...settings, loudness: entry.id })}
              >
                {entry.label}
                <span className="sys-mono dv-chip-size">
                  {String(entry.lufs).replace("-", "−")}
                </span>
              </ToggleButton>
            ))}
          </SegmentedControl>
        </div>
      )}

      {options.range === false ? null : (
        <>
          <div className="dv-field">
            <span className="dv-field-label">Range</span>
            <SegmentedControl label="Range">
              <ToggleButton
                quiet
                pressed={settings.part.mode === "whole"}
                onClick={() =>
                  onSettings({ ...settings, part: { mode: "whole" } })
                }
              >
                Whole episode
              </ToggleButton>
              <ToggleButton
                quiet
                pressed={settings.part.mode === "part"}
                onClick={() =>
                  settings.part.mode === "part"
                    ? undefined
                    : onSettings({
                        ...settings,
                        part: {
                          mode: "part",
                          start: 0,
                          end: Math.min(total, 60),
                        },
                      })
                }
              >
                Part…
              </ToggleButton>
            </SegmentedControl>
          </div>
          {settings.part.mode === "part" ? (
            <div className="dv-part">
              <TimeField
                label="In"
                value={settings.part.start}
                min={0}
                max={total}
                step={0.1}
                format={formatClock}
                parse={parseClock}
                onChange={(start) =>
                  settings.part.mode === "part" &&
                  onSettings({
                    ...settings,
                    part: clampPart({ start, end: settings.part.end }, total),
                  })
                }
              />
              <TimeField
                label="Out"
                value={settings.part.end}
                min={0}
                max={total}
                step={0.1}
                format={formatClock}
                parse={parseClock}
                onChange={(end) =>
                  settings.part.mode === "part" &&
                  onSettings({
                    ...settings,
                    part: clampPart({ start: settings.part.start, end }, total),
                  })
                }
              />
            </div>
          ) : null}
        </>
      )}

      {onChangeFolder ? (
        <p className="dv-save">
          Saves to <span className="sys-mono">{saveTo}</span>
          <Button variant="link" onClick={onChangeFolder}>
            Change
          </Button>
        </p>
      ) : null}

      {exportState.phase === "needs-model" && options.gate ? (
        <div ref={gatePanel}>
          <ModelGatePanel gate={options.gate} />
        </div>
      ) : null}
      {exportState.phase === "needs-model" && !options.gate ? (
        <StatusRow
          state="needs-you"
          title={`Needs the ${exportState.model}`}
          detail={exportState.size}
          action={
            onGetModel
              ? {
                  label: "Get",
                  icon: "cloud-download",
                  onAction: onGetModel,
                }
              : undefined
          }
        />
      ) : null}
      {exportState.phase === "running" ? (
        <div ref={runningBlock} className="dv-section">
          <StatusRow
            state="running"
            title="Exporting"
            detail={exportState.detail}
            progress={exportState.progress ?? undefined}
            action={
              onCancel
                ? {
                    label: "Cancel",
                    onAction: onCancel,
                    disabledReason: exportState.cancelReason,
                  }
                : undefined
            }
          />
          <p className="dv-note">
            You can leave this page. The export keeps going and the status bar
            shows its progress.
          </p>
          {exportState.cancelError ? (
            <InlineError
              message={`Cancel failed: ${exportState.cancelError}`}
            />
          ) : null}
        </div>
      ) : null}
      {exportState.phase === "failed" ? (
        <>
          <StatusRow
            state="failed"
            title="Export failed"
            detail={exportState.cause}
            action={
              options.onExportAgain
                ? { label: "Try again", onAction: options.onExportAgain }
                : undefined
            }
          />
          {options.gate ? (
            <ModelGateHint gate={options.gate} actionLabel="Export" />
          ) : null}
        </>
      ) : null}
      {exportState.phase === "cancelled" ? (
        <StatusRow
          state={files.length > 0 ? "done" : "needs-you"}
          title={files.length > 0 ? "Exported" : "Export cancelled"}
          detail={exportState.detail}
          action={
            options.onExportAgain
              ? { label: "Export again", onAction: options.onExportAgain }
              : undefined
          }
        />
      ) : null}
      {exportState.phase === "stale" ? (
        <StatusRow
          state="needs-you"
          title="Edited since export"
          detail={`Last export ${exportState.when}`}
        />
      ) : null}
      {exportState.phase === "done" ? (
        <StatusRow
          state="done"
          title="Exported"
          detail={exportState.summary ?? `Last export ${exportState.when}`}
        />
      ) : null}
      {exportState.phase === "done" && exportState.measured ? (
        <p className="dv-note">{exportState.measured}</p>
      ) : null}

      {dock ? null : (
        <ExportButton
          action={action}
          blocker={blocker}
          onExport={onExport}
          onReveal={() => onReveal?.()}
          onDownload={() => onDownload?.()}
        />
      )}

      {files.length > 0 ? (
        <ul className="dv-files">
          {files.map((file) => (
            <li key={file.name} className="dv-file">
              <span className="dv-file-name sys-mono">{file.name}</span>
              {file.bytes === undefined ? null : (
                <span className="sys-mono dv-file-size">
                  {formatBytes(file.bytes)}
                </span>
              )}
              {env === "none" ? null : (
                <Button
                  variant="link"
                  onClick={() =>
                    env === "app" ? onReveal?.(file) : onDownload?.(file)
                  }
                >
                  {env === "app" ? "Reveal" : "Download"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </DeliverSection>
  );
}
