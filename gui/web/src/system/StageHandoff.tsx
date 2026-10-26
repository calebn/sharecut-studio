import { useId } from "react";
import { Button } from "../ui";
import { KeyCaps } from "./KeyCaps";
import { SystemIcon } from "./SystemIcon";
import { type KeySpec, STAGES, type StageId } from "./verbs";

export type StageHandoffProps = {
  /** The stage this hands off to; its icon from `STAGES` leads the label. */
  stage: StageId;
  label: string;
  /** Secondary until the work is done, then primary once per group. */
  variant?: "secondary" | "primary";
  /** Height in px: inline 36, page 40, phone 48 (full width). */
  size?: 36 | 40 | 48;
  /** Why it cannot run, shown beside it. Present means `aria-disabled`. */
  disabledReason?: string;
  onActivate: () => void;
};

/** Display only. Mod is Cmd on Apple platforms, Ctrl elsewhere. */
const HINT: KeySpec = { key: "Enter", mod: true };

export function StageHandoff({
  stage,
  label,
  variant = "secondary",
  size = 40,
  disabledReason,
  onActivate,
}: StageHandoffProps) {
  const reasonId = useId();
  const disabled = disabledReason !== undefined && disabledReason !== "";
  const icon = STAGES.find((entry) => entry.id === stage)?.icon ?? "send";
  return (
    <span className={`sys-handoff-wrap sys-handoff-wrap--${size}`}>
      <Button
        variant={variant === "primary" ? "primary" : "default"}
        className={`sys-handoff sys-handoff--${size}`}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        onClick={disabled ? undefined : onActivate}
      >
        <SystemIcon name={icon} size={16} />
        <span className="sys-handoff-label">{label}</span>
        <SystemIcon name="arrow-right" size={16} />
        {size === 48 ? null : <KeyCaps chords={[HINT]} />}
      </Button>
      {disabled ? (
        <span id={reasonId} className="sys-handoff-reason">
          {disabledReason}
        </span>
      ) : null}
    </span>
  );
}
