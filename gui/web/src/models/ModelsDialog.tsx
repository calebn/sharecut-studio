import { Dialog, InlineError } from "../ui";
import { ANOTHER_DOWNLOAD_REASON } from "./activity";
import { ModelRow, type ModelRowAction } from "./ModelRow";
import type { ModelView } from "./types";
import { useModels } from "./useModels";
import { VariantPicker } from "./VariantPicker";

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Every model the app can use: its state, size and purpose, and the one action that fits: Download,
 * Update, Retry, or Cancel while it runs. One download runs at a time, so while one does the other
 * rows say so instead of queueing. A phone gets it as a bottom sheet (ui/Dialog).
 */
export function ModelsDialog({ open, onClose }: Props) {
  const { models, tools, busy, loadError, download, cancel } = useModels();

  const actionFor = (m: ModelView): ModelRowAction => {
    const working = m.state.kind === "downloading" || m.state.kind === "queued";
    return {
      kind: "download",
      onDownload: () => void download([m.id]),
      onCancel: () => void cancel(),
      blockedReason: busy && !working ? ANOTHER_DOWNLOAD_REASON : undefined,
    };
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Models"
      panelClassName="models-dialog-panel"
    >
      <p className="models-dialog-intro">
        ShareCut Studio keeps these on this computer. Download one when you want
        the feature it powers.
      </p>
      {tools.ffmpeg !== "installed" ? (
        <p className="model-tools" role="status">
          Audio tools are unavailable. Reinstall ShareCut Studio to restore
          them.
        </p>
      ) : null}
      <InlineError message={loadError} origin="state" />
      {models === null ? (
        loadError ? null : (
          <p role="status">Checking installed models…</p>
        )
      ) : (
        <ul className="stack tight model-list">
          {models.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              variantPicker={<VariantPicker model={m} disabled={busy} />}
              action={actionFor(m)}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}
