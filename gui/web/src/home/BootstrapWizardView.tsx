import {
  ModelRow,
  type ModelRowAction,
  type ModelView,
  VariantPicker,
} from "../models";
import { Button, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

export type BootstrapWizardViewProps = {
  /** Null until the first status arrives. */
  models: ModelView[] | null;
  loadError: string | null;
  toolsOk: boolean;
  busy: boolean;
  summary: string;
  summaryId: string;
  stuckReason: string | undefined;
  stuckId: string;
  continueReason: string | undefined;
  actionFor: (model: ModelView) => ModelRowAction;
  onContinue: () => void;
  onSkip?: () => void;
};

export function BootstrapWizardView({
  models,
  loadError,
  toolsOk,
  busy,
  summary,
  summaryId,
  stuckReason,
  stuckId,
  continueReason,
  actionFor,
  onContinue,
  onSkip,
}: BootstrapWizardViewProps) {
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
        {busy ? "Download in progress" : summary}
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
