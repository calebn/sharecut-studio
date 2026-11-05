import { useViewportClass } from "../hooks/useViewportClass";
import { Sheet } from "../system/Sheet";
import { StatusRow } from "../system/StatusRow";
import { InlineError } from "../ui";
import { inSheetOrder, WHISPER } from "./capability";
import { ModelNeedRow } from "./ModelNeedRow";
import { useModels } from "./useModels";
import { WhisperSize } from "./WhisperSize";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Every capability the app can download, one Model need row each: Transcription, Word timing,
 * Speaker split, Noise reduction. A 420 px sheet on the end edge of a desktop, the full-height
 * bottom sheet on a phone. Rows act as they change (Get, a progress ring with cancel); there is no
 * Apply. Transcription carries the Size control. One download runs at a time.
 */
export function ModelsSheet({ open, onClose }: Props) {
  const phone = useViewportClass() === "phone";
  const { models, tools, busy, loadError } = useModels();
  return (
    <Sheet
      form={phone ? "bottom" : "end"}
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
                <ModelNeedRow model={m} placement="list">
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
