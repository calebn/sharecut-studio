import { type FormEvent, type RefObject, useRef, useState } from "react";
import { Button, Dialog, Field } from "../ui";
import { errorMessage } from "../utils/apiError";

const NAME_REQUIRED = "Enter a project name.";

export type RenameProjectPopoverProps = {
  open: boolean;
  /** The project's name now; the field starts with it selected. */
  name: string;
  /** The Project button: the card sits under it and focus returns to it. */
  anchorRef: RefObject<HTMLElement | null>;
  /**
   * Enter applies the trimmed name. A rejection keeps the card open with its
   * message under the field; the host closes it by calling `onClose` once the
   * name took.
   */
  onRename: (name: string) => void | Promise<void>;
  onClose: () => void;
};

function RenameForm({
  name,
  field,
  onRename,
  onClose,
}: Pick<RenameProjectPopoverProps, "name" | "onRename" | "onClose"> & {
  field: RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next = draft.trim();
    if (next === "") {
      setError(NAME_REQUIRED);
      field.current?.focus();
      return;
    }
    if (next === name) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(next);
      onClose();
    } catch (failure) {
      setError(errorMessage(failure, "That did not save. Try again."));
      setBusy(false);
      field.current?.focus();
    }
  };

  return (
    <form className="sys-rename-form" noValidate onSubmit={submit}>
      <Field label="Project name" error={error}>
        {(control) => (
          <input
            {...control}
            ref={field}
            type="text"
            autoComplete="off"
            spellCheck
            readOnly={busy}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onFocus={(event) => event.currentTarget.select()}
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="primary"
        disabledReason={busy ? "Renaming the project." : undefined}
      >
        Rename
      </Button>
    </form>
  );
}

/**
 * The rename card under the Project button. Enter applies, Esc and a press
 * outside cancel, and leaving the field changes nothing. It is a popover
 * because a text field cannot sit in the Project menu (`role="menu"` holds
 * only items). A name the server refuses stays in the field with the reason.
 */
export function RenameProjectPopover({
  open,
  name,
  anchorRef,
  onRename,
  onClose,
}: RenameProjectPopoverProps) {
  const field = useRef<HTMLInputElement>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Rename project"
      panelClassName="sys-rename-panel"
      initialFocusRef={field}
      anchor={{
        reason:
          "the card hangs under the project title it renames, so the new name shows in place",
        ref: anchorRef,
      }}
    >
      <RenameForm
        name={name}
        field={field}
        onRename={onRename}
        onClose={onClose}
      />
    </Dialog>
  );
}
