import { useEffect, useId, useMemo } from "react";
import { type SegmentImportPreview as Preview, stagedClipUrl } from "../api";
import {
  ImportSheetFrame,
  type PreviewActions,
} from "../system/importSheet/ImportSheetFrame";
import { InlineError, Pill } from "../ui";
import { formatTimeShort } from "../utils/time";
import { stopAudition, toggleAudition, useAudition } from "./audition";
import { KIND_LABEL } from "./format";
import {
  ADD_LABEL,
  CANCEL_LABEL,
  CLOSE_LABEL,
  IMPORT_TITLE,
  lengthLine,
  outcomeLine,
  PLAY_FAILED,
  SHOW_LABEL,
} from "./importMessages";
import { PlayButton } from "./SegmentRowView";
import type { SegmentImportState } from "./useSegmentImport";

type Props = {
  state: SegmentImportState;
  onAdd: () => void;
  onCancel: () => void;
  onChooseAgain: () => void;
};

function waitingRow(preview: Preview) {
  return {
    id: preview.token,
    name: preview.name,
    kind: preview.kind,
    version: preview.version,
    versions: [preview.version],
    clips: Array.from({ length: preview.clip_count }, () => ({
      audio: "",
      offset_sec: 0,
      duration_sec: preview.duration_sec,
    })),
  };
}

function Waiting({
  preview,
  notice,
}: {
  preview: Preview;
  notice: string | null;
}) {
  const owner = useId();
  const { playingId, failedId, owner: current } = useAudition();
  const row = useMemo(() => waitingRow(preview), [preview]);
  const mine = current === owner;
  useEffect(() => () => stopAudition(owner), [owner]);
  const clips = lengthLine(preview);
  return (
    <>
      <div className="segment-import-card">
        <PlayButton
          row={row}
          playing={mine && playingId === row.id}
          onToggle={(target) =>
            toggleAudition(target, owner, (clip) =>
              stagedClipUrl(preview.token, clip),
            )
          }
        />
        <div className="segment-main">
          <span className="segment-name">{preview.name}</span>
          <span className="segment-meta">
            <Pill>{KIND_LABEL[preview.kind] ?? KIND_LABEL.other}</Pill>
            <span className="segment-length">
              {formatTimeShort(preview.duration_sec)}
            </span>
            {clips ? <span className="segment-tag">{clips}</span> : null}
          </span>
          {mine && failedId === row.id ? (
            <span className="segment-failed">{PLAY_FAILED}</span>
          ) : null}
        </div>
      </div>
      <p className="segment-import-outcome" role="status">
        {outcomeLine(preview)}
      </p>
      <InlineError message={notice} />
    </>
  );
}

const ACTIONS = (preview: Preview): PreviewActions =>
  preview.outcome === "unchanged"
    ? { cancel: CLOSE_LABEL, primary: SHOW_LABEL }
    : { cancel: CANCEL_LABEL, primary: ADD_LABEL };

export function SegmentImportPreview({ state, ...handlers }: Props) {
  return (
    <ImportSheetFrame
      state={state}
      title={IMPORT_TITLE}
      {...handlers}
      actions={ACTIONS}
      renderPreview={(preview, notice) => (
        <Waiting preview={preview} notice={notice} />
      )}
    />
  );
}
