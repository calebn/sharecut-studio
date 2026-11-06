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
