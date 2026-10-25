import { useEffect, useId, useRef, useState } from "react";
import {
  ANOTHER_DOWNLOAD_REASON,
  formatBytes,
  type ModelRowAction,
  type ModelView,
  useModels,
} from "../models";
import { BUSY_REASON } from "../ui/disabledReason";
import { BootstrapWizardView } from "./BootstrapWizardView";

export type BootstrapWizardProps = {
  onReady: () => void;
  onSkip?: () => void;
};

function needsDownload(model: ModelView): boolean {
  const kind = model.state.kind;
  return kind === "missing" || kind === "update_needed" || kind === "failed";
}

/** What Continue will fetch, in words: "Download 1.7 GB", or a count when a size is unknown. */
function summary(picked: ModelView[]): string {
  if (picked.length === 0) {
    return "Nothing to download";
  }
  if (picked.some((m) => m.sizeBytes === null)) {
    return `Download ${picked.length} ${picked.length === 1 ? "model" : "models"}`;
  }
  const total = picked.reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
  return `Download ${formatBytes(total)}`;
}

export function BootstrapWizard({ onReady, onSkip }: BootstrapWizardProps) {
  const { models, tools, ready, busy, loadError, download } = useModels();
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const stuckId = useId();
  const summaryId = useId();
  const started = useRef(false);
  const [finished, setFinished] = useState(false);

  // Set up already when the wizard opens, or a download just ended well: nothing left to ask.
  useEffect(() => {
    if (ready && (!started.current || finished)) {
      onReady();
    }
  }, [ready, finished, onReady]);

  const checked = (m: ModelView): boolean =>
    m.tier === "required" || (overrides[m.id] ?? m.tier === "recommended");
  const picked = (models ?? []).filter((m) => checked(m) && needsDownload(m));
  const toolsOk = tools.ffmpeg === "installed";

  const actionFor = (m: ModelView): ModelRowAction => {
    if (m.state.kind === "failed") {
      return {
        kind: "download",
        onDownload: () => void run([m.id]),
        blockedReason: busy ? ANOTHER_DOWNLOAD_REASON : undefined,
      };
    }
    if (!needsDownload(m)) {
      return { kind: "none" };
    }
    return {
      kind: "select",
      checked: checked(m),
      locked: m.tier === "required" || busy,
      lockedNoteId: busy ? summaryId : undefined,
      onToggle: () => setOverrides((o) => ({ ...o, [m.id]: !checked(m) })),
    };
  };

  async function run(ids: string[]) {
    started.current = true;
    setFinished(false);
    const outcome = await download(ids);
    setFinished(outcome.kind === "ok");
  }

  const stuckReason =
    !busy && picked.length === 0 && !ready
      ? "Nothing is picked to download, and setup cannot finish without the audio tools."
      : undefined;
  const continueReason = busy ? BUSY_REASON : stuckReason;

  const onContinue = () => {
    if (picked.length === 0) {
      onReady();
      return;
    }
    void run(picked.map((m) => m.id));
  };

  return (
    <BootstrapWizardView
      models={models}
      loadError={loadError}
      toolsOk={toolsOk}
      busy={busy}
      summary={summary(picked)}
      summaryId={summaryId}
      stuckReason={stuckReason}
      stuckId={stuckId}
      continueReason={continueReason}
      actionFor={actionFor}
      onContinue={onContinue}
      onSkip={onSkip}
    />
  );
}
