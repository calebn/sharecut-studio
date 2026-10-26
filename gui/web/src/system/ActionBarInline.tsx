import { type ReactNode, useId, useState } from "react";
import { Button } from "../ui";
import { SystemIcon } from "./SystemIcon";
import { capsOf, hintOf, iconOf, verbOf } from "./verbDisplay";
import { STAGES, type VerbId } from "./verbs";

export type ActionBarInlineProps = {
  /** The object's primary verb. Absent for an object with no primary. */
  verb?: VerbId;
  /** The word on the primary button when it differs from the verb label: "Looks right". */
  verbLabel?: string;
  /** Why the primary cannot be used yet. */
  verbDisabledReason?: string;
  /** `dock` is the phone's 64 px row: Keep, A/B in the middle, verb. */
  form?: "inline" | "dock";
  /** A/B audition. Shown in the dock form and in the guest bar. */
  center?: ReactNode;
  /** A guest sees Hear and Comment only. */
  readOnly?: boolean;
  /** Editor guests and the owner. Viewer and Commenter guests cannot open Edit. */
  canEdit?: boolean;
  /** The primary is replaced by the prompt while one is open. */
  promptOpen?: boolean;
  onKeep?: () => void;
  onVerb?: () => void;
  onLater?: () => void;
  onOpenInEdit?: () => void;
  onComment?: () => void;
};

const verbButtonProps = (id: VerbId) => {
  const def = verbOf(id);
  return {
    label: def.label,
    title: `${def.label}${hintOf(def)}`,
    icon: iconOf(id),
  };
};

const edit = STAGES.find((stage) => stage.id === "edit");
const editKey = verbOf("goToStage").keys.find((spec) => spec.key === "E");
const editTitle = `Open in ${edit?.label ?? "Edit"}${editKey ? ` (${capsOf(editKey).join(" ")})` : ""}`;

/** Keep sits left of the primary, which is the only accent fill. Verbs that do not apply are absent. */
export function ActionBarInline({
  verb,
  verbLabel,
  verbDisabledReason,
  form = "inline",
  center,
  readOnly = false,
  canEdit = !readOnly,
  promptOpen = false,
  onKeep,
  onVerb,
  onLater,
  onOpenInEdit,
  onComment,
}: ActionBarInlineProps) {
  const def = verb ? verbOf(verb) : null;
  const dock = form === "dock";
  const keepButton = verbButtonProps("keep");
  const laterButton = verbButtonProps("later");
  const commentButton = verbButtonProps("comment");

  const keep = (
    <Button onClick={onKeep} title={keepButton.title}>
      <SystemIcon name={keepButton.icon} size={16} />
      {keepButton.label}
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
    <Button variant="link" onClick={onLater} title={laterButton.title}>
      <SystemIcon name={laterButton.icon} size={16} />
      {laterButton.label}
    </Button>
  );
  const comment = (
    <Button variant="link" onClick={onComment} title={commentButton.title}>
      <SystemIcon name={commentButton.icon} size={16} />
      {commentButton.label}
    </Button>
  );
  const openInEdit = canEdit ? (
    <Button variant="link" onClick={onOpenInEdit} title={editTitle}>
      <SystemIcon name={edit?.icon ?? "stage-edit"} size={16} />
      Open in {edit?.label ?? "Edit"}
    </Button>
  ) : null;

  let body: ReactNode;
  if (dock) {
    body = (
      <>
        <div className="sys-dock-slot sys-dock-slot--start">
          {readOnly ? comment : keep}
        </div>
        <div className="sys-dock-slot">{center}</div>
        <div className="sys-dock-slot sys-dock-slot--end">
          {readOnly ? openInEdit : primary}
        </div>
      </>
    );
  } else if (readOnly) {
    body = (
      <>
        {comment}
        {center}
        <span className="sys-actions-spacer" />
        {openInEdit}
      </>
    );
  } else {
    body = (
      <>
        {openInEdit}
        <span className="sys-actions-decide">
          {later}
          {keep}
          {primary}
        </span>
      </>
    );
  }
  return (
    <div
      className={`sys-actions sys-actions--${form}`}
      role="group"
      aria-label="Actions"
    >
      {body}
    </div>
  );
}

export type ActionPromptProps = {
  verb: VerbId;
  message?: string;
  /** "Check 3 words". */
  checkLabel: string;
  onConfirm: (note?: string) => void;
  onCheck: () => void;
};

/** Offers to do it anyway, check first or add a note. It never blocks and shows once per session. */
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
