import { useViewportClass } from "../hooks/useViewportClass";
import { Sheet } from "../system/Sheet";
import { StatusRow } from "../system/StatusRow";
import { InlineError } from "../ui";
import { inSheetOrder, targetOfRow, WHISPER } from "./capability";
import { ModelNeedRow } from "./ModelNeedRow";
import { useModels } from "./useModels";
import { WhisperSize } from "./WhisperSize";

type Props = {
  open: boolean;
  onClose: () => void;
  /** `phone` is the full-height bottom sheet; `desktop` the 420 px sheet on the right. */
  viewerWidth?: "desktop" | "phone";
};

/**
 * Every capability the app can download, one Model need row each: Transcription, Word timing,
 * Speaker split, Noise reduction. Rows act as they change (Get, a progress ring with cancel); there
 * is no Apply. Transcription carries the Size control. One download runs at a time.
 */
export function ModelsSheet({ open, onClose, viewerWidth }: Props) {
  const shell = useViewportClass();
  const width = viewerWidth ?? (shell === "phone" ? "phone" : "desktop");
  const { models, tools, busy, loadError } = useModels();
  return (
    <Sheet
      form={width === "phone" ? "bottom" : "centered"}
      open={open}
      onClose={onClose}
      title="Models"
      detent="full"
      panelClassName="models-sheet"
    >
      <div className="models-sheet-body">
        {tools.ffmpeg !== "installed" ? (
          <StatusRow
            state="failed"
            title="Audio tools are unavailable"
            detail="Reinstall ShareCut Studio to restore them."
          />
        ) : null}
        <InlineError message={loadError} origin="state" />
        {models === null ? (
          loadError ? null : (
            <p className="models-sheet-wait" role="status">
              Checking what is installed
            </p>
          )
        ) : (
          <ul className="models-sheet-list">
            {inSheetOrder(models).map((m) => (
              <li key={m.id}>
                <ModelNeedRow model={targetOfRow(m)} placement="list">
                  {m.id === WHISPER ? <WhisperSize disabled={busy} /> : null}
                </ModelNeedRow>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
