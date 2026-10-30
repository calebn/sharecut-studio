import { useState } from "react";
import { Button, Field } from "../../ui";
import { useDisabledReasonNote } from "../../ui/disabledReason";
import { editBlock, type FeedAccess, fieldOf } from "./feedLogic";
import type { FeedEdit, FieldKey } from "../../types/feedView";

type Props = {
  field: FieldKey;
  access: FeedAccess;
  onSave: (edit: FeedEdit) => void;
  onCancel: () => void;
};

/** A value only a person can supply, for a setting the listing does not show in place. */
export function FeedAsk({ field, access, onSave, onCancel }: Props) {
  const spec = fieldOf(field);
  const [text, setText] = useState("");
  const value = text.trim();
  const edit: FeedEdit = {
    op: "set",
    key: field,
    value: spec.yesNo ? value === "yes" : value,
  };
  const why =
    value === ""
      ? spec.yesNo
        ? `Choose ${spec.yesOnly ? "yes" : "yes or no"} for ${spec.label} to save.`
        : `Enter the ${spec.label} to save.`
      : editBlock(access, edit);
  const reason = useDisabledReasonNote(why);
  return (
    <section className="fd-setup fd-ask" aria-label={spec.add}>
      <form
        className="fd-setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!why) onSave(edit);
        }}
      >
        <Field label={spec.label} className="fd-setup-field">
          {(control) =>
            spec.yesNo ? (
              <select
                {...control}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person just asked to supply this value
                autoFocus
                value={text}
                onChange={(event) => setText(event.target.value)}
              >
                <option value="">Choose</option>
                <option value="yes">Yes</option>
                {spec.yesOnly ? null : <option value="no">No</option>}
              </select>
            ) : (
              <input
                {...control}
                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person just asked to supply this value
                autoFocus
                value={text}
                autoComplete="off"
                onChange={(event) => setText(event.target.value)}
              />
            )
          }
        </Field>
        <Button
          type="submit"
          variant="primary"
          disabledReason={why ?? undefined}
          {...reason.describedBy}
        >
          Save
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
        {reason.note}
      </form>
    </section>
  );
}
