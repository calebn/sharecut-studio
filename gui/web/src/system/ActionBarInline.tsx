import { type ReactNode, useId, useState } from "react";
import { Button } from "../ui";
import { ActionBar, type ActionBarProps } from "./ActionBar";
import type { BarId } from "./editActionSets";
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
  /** Id of the note that shows `verbDisabledReason`. */
  verbNoteId?: string;
  /** `dock` is the phone's 64 px row: Keep, A/B in the middle, verb. */
  form?: "inline" | "dock";
  /** A/B audition. Shown in the dock form and in the guest bar. */
  center?: ReactNode;
  /** A guest sees Hear and Comment only. */
  readOnly?: boolean;
  /** Editor guests and the owner. Viewer and Commenter guests cannot open Edit. */
  canEdit?: boolean;
  /** False hides Open in Edit for a host that is already in Edit (the compact card). Permission stays in `canEdit`. */
  showOpenInEdit?: boolean;
  /** The word on the Keep side when it is not Keep: "Skip" for a pickup. */
  keepLabel?: string;
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
  verbNoteId,
  form = "inline",
  center,
  readOnly = false,
  canEdit = !readOnly,
  showOpenInEdit = true,
  promptOpen = false,
  keepLabel,
  onKeep,
  onVerb,
  onLater,
  onOpenInEdit,
  onComment,
}: ActionBarInlineProps) {
  const dock = form === "dock";
  const commentButton = verbButtonProps("comment");
  const primary: ActionBarProps["primary"] =
    verb && verbOf(verb).icon && !promptOpen
      ? {
          id: verb,
          label: verbLabel,
          disabledReason: verbDisabledReason,
          describedBy: verbDisabledReason ? verbNoteId : undefined,
        }
      : undefined;
  const openInEdit =
    canEdit && showOpenInEdit ? (
      <Button variant="link" onClick={onOpenInEdit} title={editTitle}>
        <SystemIcon name={edit?.icon ?? "stage-edit"} size={16} />
        Open in {edit?.label ?? "Edit"}
      </Button>
    ) : null;
  const comment = onComment ? (
    <Button variant="link" onClick={onComment} title={commentButton.title}>
      <SystemIcon name={commentButton.icon} size={16} />
      {commentButton.label}
    </Button>
  ) : null;
  const onBarVerb = (id: BarId) => {
    if (primary && id === primary.id) onVerb?.();
    else if (id === "keep") onKeep?.();
    else if (id === "later") onLater?.();
    else if (id === "comment") onComment?.();
  };
  const placement = { form: dock ? "dock" : "inline" } as const;
  const keeps: readonly { id: BarId }[] =
    verb === "keep" || !onKeep
      ? []
      : [{ id: "keep", ...(keepLabel ? { label: keepLabel } : {}) }];
  if (readOnly)
    return (
      <ActionBar
        placement={placement}
        leading={dock ? undefined : comment}
        items={dock && onComment ? [{ id: "comment" }] : []}
        center={center}
        trailing={openInEdit}
        onVerb={onBarVerb}
      />
    );
  return (
    <ActionBar
      placement={placement}
      leading={dock ? undefined : openInEdit}
      items={dock ? keeps : [...keeps, { id: "later", tone: "link" }]}
      center={center}
      primary={primary}
      onVerb={onBarVerb}
    />
  );
}

export type ActionPromptProps = {
  verb: VerbId;
  message?: string;
  /** "Check 3 words". Absent when there is nothing to check first. */
  checkLabel?: string;
  /** False when the reason is not recorded anywhere, so no note is offered. */
  allowNote?: boolean;
  onConfirm: (note?: string) => void;
  onCheck?: () => void;
};

/** Offers to do it anyway, check first or add a note. It never blocks and shows once per session. */
export function ActionPrompt({
  verb,
  message = "The transcript isn't checked yet.",
  checkLabel,
  allowNote = true,
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
        {onCheck && checkLabel ? (
          <Button variant="link" onClick={onCheck}>
            <SystemIcon name="ear" size={16} />
            {checkLabel}
          </Button>
        ) : null}
        {allowNote ? (
          <Button
            variant="link"
            aria-expanded={adding}
            aria-controls={noteId}
            onClick={() => setAdding(!adding)}
          >
            Add a note
          </Button>
        ) : null}
      </div>
      {allowNote && adding ? (
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
