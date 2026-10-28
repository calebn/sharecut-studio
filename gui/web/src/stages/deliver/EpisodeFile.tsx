import { formatBytes } from "../../models";
import { Skeleton } from "../../system/Skeleton";
import { StatusRow } from "../../system/StatusRow";
import { TimeField } from "../../system/TimeField";
import { Button, SegmentedControl, ToggleButton } from "../../ui";
import { DeliverSection } from "./DeliverSection";
import {
  clampPart,
  type DeliverEnv,
  type EpisodeSettings,
  type ExportFile,
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
  /** False when the host cannot honor the format, loudness and range choices. */
  showSettings?: boolean;
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
  showSettings = true,
  onSettings,
  onChangeFolder,
  onExport,
  onGetModel,
  onCancel,
  onReveal,
  onDownload,
}: Props) {
  if (state === "loading") {
    return (
      <DeliverSection title="Episode file">
        <Skeleton layout="list" rows={4} />
      </DeliverSection>
    );
  }
  const seconds = partSeconds(settings.part, total);
  const blocker = exportBlocker(settings, exportState);
  const action = primaryAction(exportState, env);
  const toggleFormat = (id: FormatId) =>
    onSettings({
      ...settings,
      formats: settings.formats.includes(id)
        ? settings.formats.filter((f) => f !== id)
        : [...settings.formats, id],
    });
  const files =
    exportState.phase === "done" || exportState.phase === "stale"
      ? exportState.files
      : [];

  return (
    <DeliverSection title="Episode file">
      {showSettings ? (
        <>
          <div className="dv-chips" role="group" aria-label="Formats">
            {FORMATS.map((format) => (
              <ToggleButton
                key={format.id}
                pressed={settings.formats.includes(format.id)}
                onClick={() => toggleFormat(format.id)}
              >
                {format.label}
                <span className="sys-mono dv-chip-size">
                  {formatBytes(estimateBytes(format.id, seconds))}
                </span>
              </ToggleButton>
            ))}
          </div>
          <p className="dv-note">
            Captions and transcript are written with every export.
          </p>

          <div className="dv-field">
            <span className="dv-field-label">Loudness</span>
            <SegmentedControl label="Loudness">
              {LOUDNESS.map((entry) => (
                <ToggleButton
                  key={entry.id}
                  quiet
                  pressed={settings.loudness === entry.id}
                  onClick={() =>
                    onSettings({ ...settings, loudness: entry.id })
                  }
                >
                  {entry.label}
                  <span className="sys-mono dv-chip-size">
                    {String(entry.lufs).replace("-", "−")}
                  </span>
                </ToggleButton>
              ))}
            </SegmentedControl>
          </div>

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
      ) : null}

      {onChangeFolder ? (
        <p className="dv-save">
          Saves to <span className="sys-mono">{saveTo}</span>
          <Button variant="link" onClick={onChangeFolder}>
            Change
          </Button>
        </p>
      ) : null}

      {exportState.phase === "needs-model" ? (
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
        <StatusRow
          state="running"
          title="Exporting"
          detail={exportState.detail}
          progress={exportState.progress}
          action={
            onCancel ? { label: "Cancel", onAction: onCancel } : undefined
          }
        />
      ) : null}
      {exportState.phase === "failed" ? (
        <StatusRow
          state="failed"
          title="Export failed"
          detail={exportState.cause}
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
          detail={`Last export ${exportState.when}`}
        />
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
              <span className="sys-mono dv-file-size">
                {formatBytes(file.bytes)}
              </span>
              <Button
                variant="link"
                onClick={() =>
                  env === "app" ? onReveal?.(file) : onDownload?.(file)
                }
              >
                {env === "app" ? "Reveal" : "Download"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </DeliverSection>
  );
}
