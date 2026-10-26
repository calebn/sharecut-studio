import { type ReactNode, useId, useState } from "react";
import { Button } from "../ui";
import { SystemIcon } from "./SystemIcon";
import { capsOf, hintOf, verbOf } from "./verbDisplay";
import type { VerbId } from "./verbs";

export type ActionBarInlineProps = {
  /** The object's primary verb. Absent for an object with no primary. */
  verb?: VerbId;
  /** Overrides the verb's word on the button: "Looks right". */
  verbLabel?: string;
  /** Why the primary cannot be used yet. */
  verbDisabledReason?: string;
  /** `inline` sits in a card; `dock` is the phone's 64 px row with A/B in the middle. */
  form?: "inline" | "dock";
  /** A/B audition for the dock form. */
  center?: ReactNode;
  /** A guest sees Hear and Comment only. */
  readOnly?: boolean;
  /** The primary is replaced by the prompt while one is open. */
  promptOpen?: boolean;
  onKeep?: () => void;
  onVerb?: () => void;
  onLater?: () => void;
  onOpenInEdit?: () => void;
};

const keyHint = (id: VerbId) => hintOf(verbOf(id));
const editKey = verbOf("goToStage").keys.find((spec) => spec.key === "E");
const editHint = editKey ? ` (${capsOf(editKey).join(" ")})` : "";

/**
 * The Action bar's inline form. Keep, the no, sits left of the primary, the
 * yes, which is the only accent fill. Later moves on without deciding. Open in
 * Edit sits at the far leading edge. Verbs that do not apply are absent.
 */
export function ActionBarInline({
  verb,
  verbLabel,
  verbDisabledReason,
  form = "inline",
  center,
  readOnly = false,
  promptOpen = false,
  onKeep,
  onVerb,
  onLater,
  onOpenInEdit,
}: ActionBarInlineProps) {
  const def = verb ? verbOf(verb) : null;
  const keep = (
    <Button onClick={onKeep} title={`Keep${keyHint("keep")}`}>
      <SystemIcon name="shield-check" size={16} />
      Keep
    </Button>
  );
  const primary =
    def?.icon && !promptOpen ? (
      <Button
        variant="primary"
        onClick={onVerb}
        disabledReason={verbDisabledReason}
        title={`${verbLabel ?? def.label}${hintOf(def)}`}
      >
        <SystemIcon name={def.icon} size={16} />
        {verbLabel ?? def.label}
      </Button>
    ) : null;
  const later = (
    <Button variant="link" onClick={onLater} title={`Later${keyHint("later")}`}>
      <SystemIcon name="chevron-down" size={16} />
      Later
    </Button>
  );
  const edit = (
    <Button
      variant="link"
      onClick={onOpenInEdit}
      title={`Open in Edit${editHint}`}
    >
      <SystemIcon name="stage-edit" size={16} />
      Open in Edit
    </Button>
  );

  if (readOnly) {
    return (
      <div
        className="sys-actions sys-actions--inline"
        role="group"
        aria-label="Actions"
      >
        {edit}
      </div>
    );
  }
  if (form === "dock") {
    return (
      <div
        className="sys-actions sys-actions--dock"
        role="group"
        aria-label="Actions"
      >
        <div className="sys-dock-slot sys-dock-slot--start">{keep}</div>
        <div className="sys-dock-slot">{center}</div>
        <div className="sys-dock-slot sys-dock-slot--end">{primary}</div>
      </div>
    );
  }
  return (
    <div
      className="sys-actions sys-actions--inline"
      role="group"
      aria-label="Actions"
    >
      {edit}
      <span className="sys-actions-spacer" />
      {later}
      {keep}
      {primary}
    </div>
  );
}

export type ActionPromptProps = {
  /** The verb being held back, "Cut". */
  verb: VerbId;
  /** The sentence above the buttons. */
  message?: string;
  /** "Check 3 words". */
  checkLabel: string;
  onConfirm: (note?: string) => void;
  onCheck: () => void;
};

/**
 * The inline form above the Action bar while a gate is open: do it anyway,
 * check first, or say why. It never blocks, and shows once per session.
 */
export function ActionPrompt({
  verb,
  message = "The transcript isn't checked yet.",
  checkLabel,
  onConfirm,
  onCheck,
}: ActionPromptProps) {
  const def = verbOf(verb);
  const noteId = useId();
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  const confirm = () => onConfirm(note.trim() === "" ? undefined : note.trim());
  return (
    <form
      className="sys-prompt"
      aria-label={`${def.label} anyway`}
      onSubmit={(event) => {
        event.preventDefault();
        confirm();
      }}
    >
      <p className="sys-prompt-line">
        {message} {def.label} anyway?
      </p>
      <div className="sys-prompt-row">
        <Button type="submit" variant="primary">
          {def.icon ? <SystemIcon name={def.icon} size={16} /> : null}
          {def.label} anyway
        </Button>
        <Button variant="link" onClick={onCheck}>
          <SystemIcon name="ear" size={16} />
          {checkLabel}
        </Button>
        <Button
          variant="link"
          aria-expanded={adding}
          aria-controls={noteId}
          onClick={() => setAdding(!adding)}
        >
          Add a note
        </Button>
      </div>
      {adding ? (
        <textarea
          id={noteId}
          className="sys-prompt-note"
          rows={2}
          aria-label="Your reason"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              confirm();
            }
          }}
        />
      ) : null}
    </form>
  );
}
