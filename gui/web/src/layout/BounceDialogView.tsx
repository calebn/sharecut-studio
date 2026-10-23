import { type ReactNode, useEffect, useId, useRef } from "react";
import { type ModelGate, ModelGateBody, ModelGateFooter } from "../models";
import { Button, Dialog, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

export type BounceSourceMode = "entire" | "selected" | "soloed";

export type BounceDialogViewProps = {
  rangeSummary?: string;
  open: boolean;
  onClose: () => void;
  source: BounceSourceMode;
  onSourceChange: (source: BounceSourceMode) => void;
  selectedCount: number;
  soloCount: number;
  /** A session region exists, so "Limit to session region" can be enabled. */
  hasRegion: boolean;
  useRegion: boolean;
  onUseRegionChange: (on: boolean) => void;
  includeMp3: boolean;
  onIncludeMp3Change: (on: boolean) => void;
  busy: boolean;
  error: string | null;
  onBounce: () => void;
  modelGate?: ModelGate | null;
  modelHint?: ReactNode;
};

/**
 * Production Bounce… dialog paint; job start/follow, abort-on-close and DAW
 * selection state stay with the `BounceDialog` adapter.
 */
export function BounceDialogView(props: BounceDialogViewProps) {
  const {
    rangeSummary,
    open,
    onClose,
    source,
    onSourceChange,
    selectedCount,
    soloCount,
    hasRegion,
    useRegion,
    onUseRegionChange,
    includeMp3,
    onIncludeMp3Change,
    busy,
    error,
    onBounce,
    modelGate,
    modelHint,
  } = props;
  const sourceName = useId();
  const downloadRef = useRef<HTMLButtonElement>(null);
  const prompt = modelGate?.prompt ?? null;
  const asking = prompt !== null;
  useEffect(() => {
    if (asking) {
      downloadRef.current?.focus();
    }
  }, [asking]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bounce…"
      closeDisabled={prompt?.phase === "downloading"}
      panelClassName="bounce-dialog-panel"
      footer={
        <div className="bounce-dialog-footer">
          {modelGate && prompt ? (
            <ModelGateFooter gate={modelGate} primaryRef={downloadRef} />
          ) : (
            <>
              <InlineError message={error} />
              {modelHint}
              <div className="bounce-dialog-actions">
                <Button
                  variant="primary"
                  type="button"
                  disabledReason={busy ? BUSY_REASON : undefined}
                  onClick={onBounce}
                >
                  {busy ? "Bouncing…" : "Bounce"}
                </Button>
              </div>
            </>
          )}
        </div>
      }
    >
      <div className="bounce-dialog-body">
        {prompt ? (
          <ModelGateBody prompt={prompt} />
        ) : rangeSummary ? (
          <p>
            Selected range · {rangeSummary}. This selection is fixed for this
            export.
          </p>
        ) : (
          <fieldset className="bounce-dialog-fieldset">
            <legend>Source</legend>
            <label>
              <input
                type="radio"
                name={sourceName}
                checked={source === "entire"}
                onChange={() => onSourceChange("entire")}
              />
              <span>Entire mix</span>
            </label>
            <label>
              <input
                type="radio"
                name={sourceName}
                checked={source === "selected"}
                onChange={() => onSourceChange("selected")}
              />
              <span>Selected tracks ({selectedCount})</span>
            </label>
            <label>
              <input
                type="radio"
                name={sourceName}
                checked={source === "soloed"}
                onChange={() => onSourceChange("soloed")}
              />
              <span>Soloed tracks ({soloCount})</span>
            </label>
          </fieldset>
        )}
        {prompt ? null : (
          <div className="bounce-dialog-options">
            {!rangeSummary ? (
              <label className="bounce-dialog-check">
                <input
                  type="checkbox"
                  checked={useRegion}
                  disabled={!hasRegion}
                  onChange={(e) => onUseRegionChange(e.target.checked)}
                />
                <span>
                  Limit to session region
                  {!hasRegion ? " (no region set)" : ""}
                </span>
              </label>
            ) : null}
            <label className="bounce-dialog-check">
              <input
                type="checkbox"
                checked={includeMp3}
                onChange={(e) => onIncludeMp3Change(e.target.checked)}
              />
              <span>Also write MP3</span>
            </label>
          </div>
        )}
      </div>
    </Dialog>
  );
}
