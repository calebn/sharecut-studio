import { useEffect, useId, useRef } from "react";
import { formatBytes, ModelNeedRow, useModelNeedFocus } from "../../models";
import { ScrubField } from "../../system/ScrubField";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { Button, InlineError, SegmentedControl, ToggleButton } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import {
  afterExportOf,
  type DeliverFiles,
  filesOfKinds,
  type NamedExportFiles,
} from "./deliverFiles";
import {
  clampPart,
  type EpisodeSettings,
  type ExportOptions,
  type ExportState,
  estimateBytes,
  exportBlocker,
  FORMATS,
  type FormatId,
  LOUDNESS,
  partSeconds,
} from "./deliverLogic";
import { ExportButton } from "./ExportButton";
import { ExportedFiles } from "./ExportedFiles";

type Props = {
  settings: EpisodeSettings;
  /** Episode length in seconds. */
  total: number;
  /** Where files go, as a folder name. */
  saveTo?: string;
  exportState: ExportState;
  /** The audio and chapters files the export folder holds. */
  files?: DeliverFiles;
  namedFiles?: NamedExportFiles;
  state?: "ready" | "loading";
  /** The Export button lives in the phone dock instead of here. */
  dock?: boolean;
  options?: ExportOptions;
  hasTranscriptSection: boolean;
  onSettings: (next: EpisodeSettings) => void;
  /** Without it the Saves to line is not shown. */
  onChangeFolder?: () => void;
  onExport: () => void;
  onCancel?: () => void;
};

export function EpisodeFile({
  settings,
  total,
  saveTo = "",
  exportState,
  files,
  namedFiles,
  state = "ready",
  dock = false,
  options = {},
  hasTranscriptSection,
  onSettings,
  onChangeFolder,
  onExport,
  onCancel,
}: Props) {
  const hostedLoudness = options.loudness || undefined;
  const named = hostedLoudness !== undefined && hostedLoudness.choice !== null;
  const loudnessNote = useId();
  const note = named
    ? "This export includes audio only."
    : "Available captions and transcript are included with every audio export." +
      (hasTranscriptSection ? " Choose more files in Transcript below." : "");
  const wavNote = useId();
  const runningBlock = useRef<HTMLDivElement>(null);
  const running = exportState.phase === "running";
  const wasRunning = useRef(running);
  useEffect(() => {
    if (dock && running && !wasRunning.current)
      runningBlock.current?.scrollIntoView?.({ block: "center" });
    wasRunning.current = running;
  }, [running, dock]);
  const asking = exportState.phase === "needs-model";
  const needPanel = useModelNeedFocus(asking);
  if (state === "loading") {
    return (
      <DeliverSection title="Episode file">
        <Skeleton layout="list" rows={4} />
      </DeliverSection>
    );
  }
  const seconds = partSeconds(settings.part, total);
  const formats = options.formats ?? FORMATS;
  const missing = settings.formats.filter(
    (key) => !formats.some((format) => format.id === key),
  );
  const blocker = exportBlocker(settings, exportState, options);
  const toggleFormat = (id: FormatId) =>
    onSettings({
      ...settings,
      formats: settings.formats.includes(id)
        ? settings.formats.filter((f) => f !== id)
        : [...settings.formats, id],
    });
  const loudnessButtons =
    options.loudness === false
      ? null
      : LOUDNESS.map((entry) => (
          <ToggleButton
            key={entry.id}
            quiet
            pressed={
              (hostedLoudness ? hostedLoudness.choice : settings.loudness) ===
              entry.id
            }
            onClick={() =>
              hostedLoudness
                ? hostedLoudness.onChoice(entry.id)
                : onSettings({ ...settings, loudness: entry.id })
            }
          >
            {entry.label}
            <span className="sys-mono dv-chip-size">
              {String(entry.lufs).replace("-", "−")}
            </span>
          </ToggleButton>
        ));
  const captionNote = (
    <p className="dv-note" id={loudnessNote}>
      {note}
    </p>
  );
  const projectLoudnessNote =
    !named && options.loudnessNote ? (
      <p className="dv-note">
        {options.loudnessNote} The target mirrors the loudness setting in
        Prepare.
      </p>
    ) : null;
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
          {missing.map((key) => (
            <ToggleButton key={key} pressed onClick={() => toggleFormat(key)}>
              {key.toUpperCase()} · unavailable
            </ToggleButton>
          ))}
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
          {named
            ? "A lossless WAV is included with this export."
            : "WAV is the lossless master and is written with every export."}
        </p>
      ) : null}
      {options.settingsError ? (
        <InlineError
          message={`Export settings did not load: ${options.settingsError}. Export uses this project's saved formats.`}
        />
      ) : null}
      {hostedLoudness ? null : (
        <>
          {captionNote}
          {projectLoudnessNote}
        </>
      )}
      {options.loudness !== false &&
      (hostedLoudness ? !options.loading : !options.loudnessNote) ? (
        <div className="dv-field">
          <span className="dv-field-label">Loudness</span>
          {hostedLoudness ? (
            <div
              className="dv-chips"
              role="group"
              aria-label="Loudness"
              aria-describedby={loudnessNote}
            >
              <ToggleButton
                quiet
                pressed={hostedLoudness.choice === null}
                onClick={() => hostedLoudness.onChoice(null)}
              >
                Project default
              </ToggleButton>
              {loudnessButtons}
            </div>
          ) : (
            <SegmentedControl label="Loudness">
              {loudnessButtons}
            </SegmentedControl>
          )}
        </div>
      ) : null}
      {hostedLoudness ? (
        <>
          {projectLoudnessNote}
          {captionNote}
        </>
      ) : null}

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
              <div className="dv-part-field">
                <span className="dv-part-label" aria-hidden="true">
                  In
                </span>
                <ScrubField
                  label="In"
                  value={settings.part.start}
                  min={0}
                  max={total}
                  step={0.1}
                  unit="s"
                  decimals={2}
                  commitOnUnmount
                  onCommit={(start) =>
                    settings.part.mode === "part" &&
                    onSettings({
                      ...settings,
                      part: clampPart({ start, end: settings.part.end }, total),
                    })
                  }
                />
              </div>
              <div className="dv-part-field">
                <span className="dv-part-label" aria-hidden="true">
                  Out
                </span>
                <ScrubField
                  label="Out"
                  value={settings.part.end}
                  min={0}
                  max={total}
                  step={0.1}
                  unit="s"
                  decimals={2}
                  commitOnUnmount
                  onCommit={(end) =>
                    settings.part.mode === "part" &&
                    onSettings({
                      ...settings,
                      part: clampPart(
                        { start: settings.part.start, end },
                        total,
                      ),
                    })
                  }
                />
              </div>
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

      {exportState.phase === "needs-model" ? (
        <div ref={needPanel}>
          <ModelNeedRow model={exportState.model} />
        </div>
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
        <StatusRow
          state="failed"
          title="Export failed"
          detail={exportState.cause}
          action={
            options.onExportAgain
              ? {
                  label: "Try again",
                  onAction: options.onExportAgain,
                  disabledReason: blocker,
                }
              : undefined
          }
        />
      ) : null}
      {exportState.phase === "cancelled" ? (
        <StatusRow
          state={exportState.when ? "done" : "needs-you"}
          title={exportState.when ? "Exported" : "Export cancelled"}
          detail={exportState.detail}
          action={
            options.onExportAgain
              ? {
                  label: "Export again",
                  onAction: options.onExportAgain,
                  disabledReason: blocker,
                }
              : undefined
          }
        />
      ) : null}
      {exportState.phase === "stale" ? (
        <StatusRow
          state="needs-you"
          title={
            namedFiles ||
            exportState.staleReason === "other" ||
            (hostedLoudness &&
              hostedLoudness.choice !==
                (exportState.exported.namedTarget ?? null))
              ? "Export is out of date"
              : "Edited since export"
          }
          detail={exportState.summary ?? `Last export ${exportState.when}`}
          action={{
            label: "Export again",
            onAction: onExport,
            disabledReason: blocker,
          }}
        />
      ) : null}
      {exportState.phase === "done" || exportState.phase === "unconfirmed" ? (
        <>
          <StatusRow
            state="done"
            title="Exported"
            detail={exportState.summary ?? `Last export ${exportState.when}`}
          />
          {exportState.phase === "unconfirmed" ? (
            <p className="dv-note">
              Current export settings could not be checked.
            </p>
          ) : null}
        </>
      ) : null}
      {"measured" in exportState && exportState.measured ? (
        <p className="dv-note">{exportState.measured}</p>
      ) : null}

      {dock ? null : (
        <ExportButton
          exporting={running}
          blocker={blocker}
          after={afterExportOf(
            namedFiles ? undefined : files,
            exportState.phase === "done",
          )}
          onExport={onExport}
        />
      )}

      {namedFiles ? (
        <NamedFiles result={namedFiles} />
      ) : files ? (
        <>
          {files.files.some(
            (file) => file.kind === "audio" || file.kind === "chapters",
          ) &&
          (exportState.phase === "failed" ||
            (exportState.phase === "cancelled" && !exportState.when)) ? (
            <h3 className="dv-file-group-title">Previously exported files</h3>
          ) : null}
          <ExportedFiles
            {...filesOfKinds(files, ["audio", "chapters"], running)}
          />
        </>
      ) : null}
    </DeliverSection>
  );
}

function NamedFiles({ result }: { result: NamedExportFiles }) {
  const heading = useId();
  if (result.state === "unpublished") return null;
  return (
    <div className="dv-file-group" role="group" aria-labelledby={heading}>
      <h3 className="dv-file-group-title" id={heading}>
        {result.label}
      </h3>
      {result.state === "ready" ? (
        <ExportedFiles
          {...result.rows}
          staleLabel="Export is out of date"
          largeFileNote="This export includes a large file. Use Wi-Fi to download it."
        />
      ) : result.state === "loading" ? (
        <p className="dv-note">Loading exported files…</p>
      ) : (
        <>
          <InlineError
            message={
              result.state === "missing"
                ? "Some files from this export are missing."
                : "Exported files could not be loaded."
            }
          />
          <Button variant="link" onClick={result.reload}>
            Refresh files
          </Button>
        </>
      )}
    </div>
  );
}
