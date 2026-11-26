import { type RefObject, useEffect, useId, useMemo, useRef } from "react";
import { type SegmentImportPreview as Preview, stagedClipUrl } from "../api";
import { useViewportClass } from "../hooks/useViewportClass";
import { opensFull, useCrampedSheet } from "../stages/edit/useCrampedSheet";
import { Sheet } from "../system/Sheet";
import { Button, InlineError, Pill } from "../ui";
import { formatTimeShort } from "../utils/time";
import { stopAudition, toggleAudition, useAudition } from "./audition";
import { KIND_LABEL } from "./format";
import {
  ADD_LABEL,
  ADDING_LABEL,
  CANCEL_LABEL,
  CHOOSE_AGAIN_LABEL,
  CLOSE_LABEL,
  checkingMessage,
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

type FooterProps = Props & { primaryRef: RefObject<HTMLButtonElement | null> };

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

function Footer({
  state,
  onAdd,
  onCancel,
  onChooseAgain,
  primaryRef,
}: FooterProps) {
  if (state.phase === "error") {
    return (
      <div className="sys-segment-actions">
        <Button onClick={onCancel}>{CLOSE_LABEL}</Button>
        <Button variant="primary" ref={primaryRef} onClick={onChooseAgain}>
          {CHOOSE_AGAIN_LABEL}
        </Button>
      </div>
    );
  }
  if (state.phase === "uploading" || state.phase === "idle") {
    return (
      <div className="sys-segment-actions">
        <Button onClick={onCancel}>{CANCEL_LABEL}</Button>
      </div>
    );
  }
  const committing = state.phase === "committing";
  const unchanged = state.preview.outcome === "unchanged";
  return (
    <div className="sys-segment-actions">
      <Button
        onClick={onCancel}
        disabledReason={committing ? "Adding to your library." : undefined}
      >
        {unchanged ? CLOSE_LABEL : CANCEL_LABEL}
      </Button>
      <Button
        variant="primary"
        ref={primaryRef}
        onClick={onAdd}
        disabledReason={committing ? ADDING_LABEL : undefined}
      >
        {committing ? ADDING_LABEL : unchanged ? SHOW_LABEL : ADD_LABEL}
      </Button>
    </div>
  );
}

export function SegmentImportPreview(props: Props) {
  const { state, onCancel } = props;
  const primaryRef = useRef<HTMLButtonElement>(null);
  const phone = useViewportClass() === "phone";
  const cramped = useCrampedSheet();
  const pinned = !(phone && cramped);
  const actions = <Footer {...props} primaryRef={primaryRef} />;
  let body = null;
  if (state.phase === "uploading") {
    body = (
      <p className="segment-import-status" role="status">
        {checkingMessage(state.fileName)}
      </p>
    );
  } else if (state.phase === "preview") {
    body = <Waiting preview={state.preview} notice={state.notice} />;
  } else if (state.phase === "committing") {
    body = <Waiting preview={state.preview} notice={null} />;
  } else if (state.phase === "error") {
    body = (
      <>
        <p className="segment-import-file">{state.fileName}</p>
        <InlineError message={state.message} />
      </>
    );
  }
  return (
    <Sheet
      form={phone ? "bottom" : "centered"}
      open={state.phase !== "idle"}
      title={IMPORT_TITLE}
      detent={phone && opensFull() ? "full" : "fit"}
      initialFocusRef={primaryRef}
      footer={pinned ? actions : undefined}
      onClose={onCancel}
    >
      <div className="segment-import">
        {body}
        {pinned ? null : actions}
      </div>
    </Sheet>
  );
}
