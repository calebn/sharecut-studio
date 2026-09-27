import { useId } from "react";
import { Button, Dialog, InlineError } from "../ui";

export type BounceSourceMode = "entire" | "selected" | "soloed";

export type BounceDialogViewProps = {
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
      <fieldset className="bounce-dialog-fieldset">
        <legend>Source</legend>
        <label>
          <input
            type="radio"
            name={sourceName}
            checked={source === "entire"}
            onChange={() => onSourceChange("entire")}
          />
          Entire mix
        </label>
        <label>
          <input
            type="radio"
            name={sourceName}
            checked={source === "selected"}
            onChange={() => onSourceChange("selected")}
          />
          Selected tracks ({selectedCount})
        </label>
        <label>
          <input
            type="radio"
            name={sourceName}
            checked={source === "soloed"}
            onChange={() => onSourceChange("soloed")}
          />
          Soloed tracks ({soloCount})
        </label>
      </fieldset>
      <label className="bounce-dialog-check">
        <input
          type="checkbox"
          checked={useRegion}
          disabled={!hasRegion}
          onChange={(e) => onUseRegionChange(e.target.checked)}
        />
        Limit to session region
        {!hasRegion ? " (no region set)" : ""}
      </label>
      <label className="bounce-dialog-check">
        <input
          type="checkbox"
          checked={includeMp3}
          onChange={(e) => onIncludeMp3Change(e.target.checked)}
        />
        Also write MP3
      </label>
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
    </Dialog>
  );
}
