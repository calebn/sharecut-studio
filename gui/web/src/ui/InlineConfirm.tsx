import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";
import { registerInlineConfirm } from "./inlineConfirmGate";

type Props = {
  /** Names the target and the consequence, e.g. "Stop sharing this Viewer link? Anyone using it loses access." */
  prompt: string;
  /** Safe choice, shown first and focused on open, e.g. "Keep link". */
  keepLabel: string;
  /** Destructive choice, e.g. "Stop sharing". */
  actionLabel: string;
  onKeep: () => void;
  onConfirm: () => void;
  disabled?: boolean;
};

/**
 * Two-step confirmation in place of the control that asked for it: the
 * consequence, then Keep (safe, left) and a danger action (right). It never
 * stacks a second dialog over the one it sits in. While it is enabled, Escape
 * in the enclosing dialog calls Keep instead of closing the dialog.
 */
export function InlineConfirm({
  prompt,
  keepLabel,
  actionLabel,
  onKeep,
  onConfirm,
  disabled = false,
}: Props) {
  const promptId = useId();
  const keepRef = useRef<HTMLButtonElement>(null);

  const onKeepRef = useRef(onKeep);
  onKeepRef.current = onKeep;

  useEffect(() => {
    keepRef.current?.focus();
  }, []);

  useEffect(() => {
    if (disabled) {
      return;
    }
    return registerInlineConfirm(() => onKeepRef.current());
  }, [disabled]);

  return (
    <div role="group" aria-labelledby={promptId} className="ui-inline-confirm">
      <p id={promptId} className="ui-inline-confirm-prompt">
        {prompt}
      </p>
      <div className="ui-inline-confirm-actions">
        <Button ref={keepRef} disabled={disabled} onClick={onKeep}>
          {keepLabel}
        </Button>
        <Button variant="danger" disabled={disabled} onClick={onConfirm}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
