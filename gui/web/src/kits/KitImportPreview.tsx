import type { KitImportPreview as Preview } from "../api";
import {
  ImportSheetFrame,
  type PreviewActions,
} from "../system/importSheet/ImportSheetFrame";
import { CANCEL_LABEL, CLOSE_LABEL } from "../system/importSheet/importCopy";
import { InlineError } from "../ui";
import {
  countsLine,
  isUnchangedKit,
  KIT_ADD_LABEL,
  KIT_IMPORT_TITLE,
  outcomeLine,
} from "./importMessages";
import { KitImportEntries } from "./KitImportEntries";
import type { KitImportState } from "./useKitImport";

type Props = {
  state: KitImportState;
  onAdd: () => void;
  onCancel: () => void;
  onChooseAgain: () => void;
};

const ACTIONS = (preview: Preview): PreviewActions =>
  isUnchangedKit(preview)
    ? { cancel: CLOSE_LABEL, primary: null }
    : { cancel: CANCEL_LABEL, primary: KIT_ADD_LABEL };

function Waiting({
  preview,
  notice,
}: {
  preview: Preview;
  notice: string | null;
}) {
  return (
    <>
      <div className="kit-import-head">
        <h3 className="kit-import-name">{preview.name}</h3>
        <p className="segment-import-outcome" role="status">
          {outcomeLine(preview)}
        </p>
        <p className="kit-import-counts">{countsLine(preview)}</p>
      </div>
      <InlineError message={notice} />
      <KitImportEntries entries={preview.entries} />
    </>
  );
}

/** The sheet a chosen kit file opens: what it holds and what adding it would do. No audio plays. */
export function KitImportPreview({ state, ...handlers }: Props) {
  return (
    <ImportSheetFrame
      state={state}
      title={KIT_IMPORT_TITLE}
      {...handlers}
      actions={ACTIONS}
      renderPreview={(preview, notice) => (
        <Waiting preview={preview} notice={notice} />
      )}
    />
  );
}
