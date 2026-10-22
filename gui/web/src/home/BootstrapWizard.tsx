import { useEffect, useId, useRef, useState } from "react";
import {
  ANOTHER_DOWNLOAD_REASON,
  formatBytes,
  ModelRow,
  type ModelRowAction,
  type ModelView,
  useModels,
  VariantPicker,
} from "../models";
import { Button, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

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

  if (models === null) {
    return (
      <div
        className="box elevated bootstrap-wizard stack"
        role={loadError ? undefined : "status"}
      >
        {loadError ? (
          <>
            <InlineError message={loadError} />
            {onSkip ? (
              <div className="cluster">
                <Button onClick={onSkip}>Skip for now</Button>
              </div>
            ) : null}
          </>
        ) : (
          <p>Checking installed tools…</p>
        )}
      </div>
    );
  }

  const checked = (m: ModelView): boolean =>
    m.tier === "required" || (overrides[m.id] ?? m.tier === "recommended");
  const picked = models.filter((m) => checked(m) && needsDownload(m));
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
    picked.length === 0 && !ready
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
    <div
      className="box elevated bootstrap-wizard stack"
      role="region"
      aria-label="Setup"
    >
      <div className="bootstrap-wizard-header stack">
        <h1>Set up ShareCut Studio</h1>
        <p>
          Choose the models to download. Nothing downloads until you click
          Continue.
        </p>
      </div>
      <p className="model-tools" role="status">
        Audio tools: {toolsOk ? "ready" : "unavailable"}
      </p>
      {!toolsOk ? (
        <p>
          Reinstall ShareCut Studio, or follow the{" "}
          <a href="https://github.com/calebn/sharecut-studio/blob/main/docs/setup.md#acquire-the-pinned-ffmpeg-pair">
            setup guide for the audio tools
          </a>
          .
        </p>
      ) : null}
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
      <p className="model-summary" id={summaryId}>
        {busy ? "Download in progress" : summary(picked)}
      </p>
      {stuckReason ? (
        <p className="model-note" id={stuckId}>
          {stuckReason}
        </p>
      ) : null}
      <div className="cluster">
        <Button
          variant="primary"
          onClick={onContinue}
          disabledReason={continueReason}
          aria-describedby={
            busy ? summaryId : stuckReason ? stuckId : undefined
          }
        >
          {busy ? "Downloading…" : "Continue"}
        </Button>
        {onSkip ? (
          <Button
            onClick={onSkip}
            disabledReason={busy ? BUSY_REASON : undefined}
            aria-describedby={busy ? summaryId : undefined}
            variant="link"
          >
            Skip for now
          </Button>
        ) : null}
      </div>
      {onSkip ? (
        <p className="model-note">You can download these later from Models.</p>
      ) : null}
    </div>
  );
}
