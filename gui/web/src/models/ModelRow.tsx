import { type ReactNode, useId } from "react";
import { Button, InlineError, Pill } from "../ui";
import {
  capitalize,
  failureHint,
  progressText,
  stateText,
  tierText,
} from "./format";
import type { ModelView } from "./types";

export type ModelRowAction =
  | {
      kind: "select";
      checked: boolean;
      /** Not changeable: a required model, or a download that has started. */
      locked: boolean;
      onToggle: () => void;
    }
  | {
      kind: "download";
      onDownload: () => void;
      /** Offered while this row downloads. */
      onCancel?: () => void;
      /** Why Download is unavailable right now (another download runs). */
      blockedReason?: string;
    }
  | { kind: "none" };

type Props = {
  model: ModelView;
  /** A control that picks this model's variant, inside the row. */
  variantPicker?: ReactNode;
  action: ModelRowAction;
};

function downloadLabel(kind: ModelView["state"]["kind"]): string {
  if (kind === "update_needed") {
    return "Update";
  }
  return kind === "failed" ? "Retry" : "Download";
}

/**
 * One model: name, tier, size, state, purpose, an optional variant picker, a byte progress bar while
 * it downloads, a plain failure with what to do, and the one action that fits its state. Nothing
 * here fetches or downloads; the owner passes the action.
 */
export function ModelRow({ model, variantPicker, action }: Props) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const purposeId = `${uid}-purpose`;
  const requiredId = `${uid}-required`;
  const blockedId = `${uid}-blocked`;
  const { state } = model;
  const requiredNote =
    action.kind === "select" && model.tier === "required"
      ? `Required for ${model.purpose}`
      : null;

  const name =
    action.kind === "select" ? (
      <label className="model-row-name model-row-select">
        <input
          type="checkbox"
          checked={action.checked}
          disabled={action.locked}
          onChange={action.onToggle}
          aria-describedby={[purposeId, requiredNote ? requiredId : null]
            .filter(Boolean)
            .join(" ")}
        />
        <span id={nameId}>{model.label}</span>
      </label>
    ) : (
      <span className="model-row-name" id={nameId}>
        {model.label}
      </span>
    );

  const buttonLabel = downloadLabel(state.kind);
  const showDownload =
    action.kind === "download" &&
    (state.kind === "missing" ||
      state.kind === "update_needed" ||
      state.kind === "failed");
  const showCancel =
    action.kind === "download" &&
    state.kind === "downloading" &&
    action.onCancel !== undefined;

  return (
    <li
      className="box stack model-row"
      data-model={model.id}
      data-state={state.kind}
    >
      <div className="cluster model-row-head">
        {name}
        <Pill>{tierText(model.tier)}</Pill>
        <span className="model-row-size">{model.size}</span>
        <span className="model-row-state" role="status">
          {stateText(state)}
        </span>
      </div>
      <p className="model-row-purpose" id={purposeId}>
        {capitalize(model.purpose)}
      </p>
      {requiredNote ? (
        <p className="model-row-note" id={requiredId}>
          {requiredNote}
        </p>
      ) : null}
      {variantPicker}
      {state.kind === "downloading" ? (
        <div className="model-row-progress">
          <progress
            aria-labelledby={nameId}
            aria-valuetext={progressText(state)}
            {...(state.total != null
              ? { value: state.bytes, max: state.total }
              : {})}
          />
          <span className="model-row-bytes">{progressText(state)}</span>
        </div>
      ) : null}
      {state.kind === "failed" ? (
        <div className="stack tight">
          <InlineError message={state.failure.plain} />
          <p className="model-row-note">{failureHint(state.failure)}</p>
        </div>
      ) : null}
      {showDownload && action.kind === "download" ? (
        <div className="model-row-actions">
          <Button
            variant={state.kind === "failed" ? "primary" : "default"}
            aria-label={`${buttonLabel} ${model.label}`}
            aria-describedby={action.blockedReason ? blockedId : undefined}
            disabledReason={action.blockedReason}
            onClick={action.onDownload}
          >
            {buttonLabel}
          </Button>
          {action.blockedReason ? (
            <p className="model-row-note" id={blockedId}>
              {action.blockedReason}
            </p>
          ) : null}
        </div>
      ) : null}
      {showCancel && action.kind === "download" ? (
        <div className="model-row-actions">
          <Button
            aria-label={`Cancel ${model.label} download`}
            onClick={action.onCancel}
          >
            Cancel
          </Button>
        </div>
      ) : null}
    </li>
  );
}
