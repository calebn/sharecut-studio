import { useId } from "react";
import { Button, Dialog, InlineError } from "../ui";

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
  } = props;
  const sourceName = useId();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bounce…"
      panelClassName="bounce-dialog-panel"
    >
      <div className="bounce-dialog-body">
        {rangeSummary ? (
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
        <div className="bounce-dialog-footer">
          <InlineError message={error} />
          <div className="bounce-dialog-actions">
            <Button
              variant="primary"
              type="button"
              disabled={busy}
              onClick={onBounce}
            >
              {busy ? "Bouncing…" : "Bounce"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
