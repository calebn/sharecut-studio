import { useEffect, useRef, useState } from "react";
import { SystemIcon } from "../../system/SystemIcon";
import { Button } from "../../ui";
import { type FixTextAnswer, FixTextField } from "./FixTextField";

export function AddPerson({
  label,
  fieldLabel,
  validate,
  onAdd,
}: {
  label: string;
  fieldLabel: string;
  validate: (text: string) => string | undefined;
  onAdd: (name: string) => FixTextAnswer;
}) {
  const [adding, setAdding] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wasAdding = useRef(false);

  useEffect(() => {
    if (wasAdding.current && !adding) button.current?.focus();
    wasAdding.current = adding;
  }, [adding]);

  if (!adding) {
    return (
      <Button
        ref={button}
        className="sys-picker-add"
        onClick={() => setAdding(true)}
      >
        <SystemIcon name="user-plus" size={14} />
        {label}
      </Button>
    );
  }
  return (
    <div className="sys-picker-row">
      <div className="sys-picker-option sys-picker-renaming">
        <SystemIcon name="user-plus" size={16} />
        <FixTextField
          value=""
          label={fieldLabel}
          commitOnBlur={false}
          validate={validate}
          onDone={async (name) => {
            if (name === null) {
              setAdding(false);
              return;
            }
            const reason = await onAdd(name);
            if (typeof reason === "string" && reason !== "") return reason;
            setAdding(false);
          }}
        />
      </div>
    </div>
  );
}
