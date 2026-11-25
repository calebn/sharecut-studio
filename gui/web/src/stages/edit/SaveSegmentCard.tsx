import {
  type FormEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SegmentKind } from "../../api";
import { segmentSaveMessage } from "../../edit/segmentSaveMessages";
import { SEGMENT_KINDS } from "../../edit/segmentSelection";
import { Sheet } from "../../system/Sheet";
import { Button, Dialog, Field } from "../../ui";
import { InlineError } from "../../ui/InlineError";

const TITLE = "Save as segment";
const NAME_REQUIRED = "Enter a name for the segment.";
const SAVING = "Saving to your library.";

const KIND_LABELS: Readonly<Record<SegmentKind, string>> = {
  intro: "Intro",
  outro: "Outro",
  sponsor: "Sponsor",
  sting: "Sting",
  other: "Other",
};

type Common = {
  summary: string;
  defaultKind: SegmentKind;
  onSave: (input: { name: string; kind: SegmentKind }) => Promise<void>;
  onClose: () => void;
};

export type SaveSegmentCardProps = Common &
  (
    | {
        form?: "anchored";
        anchorRef: RefObject<HTMLElement | null>;
        open?: boolean;
      }
    | {
        form: "bottom";
        open: boolean;
        anchorRef?: undefined;
      }
  );

function SaveSegmentForm({
  summary,
  defaultKind,
  onSave,
  onClose,
  field,
  bottom,
}: Common & {
  field: RefObject<HTMLInputElement | null>;
  bottom: boolean;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<SegmentKind>(defaultKind);
  const [nameError, setNameError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const kindTouched = useRef(false);

  useEffect(() => {
    if (!kindTouched.current) setKind(defaultKind);
  }, [defaultKind]);

  useEffect(() => {
    if (!bottom) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (
          !active ||
          active === document.body ||
          active.closest(".dialog-close, .bottom-sheet-header")
        )
          field.current?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [bottom, field]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saveInFlight.current) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError(NAME_REQUIRED);
      field.current?.focus();
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    setNameError(null);
    setFailure(null);
    try {
      await onSave({ name: trimmed, kind });
      onClose();
    } catch (error) {
      setFailure(segmentSaveMessage(error));
      saveInFlight.current = false;
      setSaving(false);
      field.current?.focus();
    }
  };

  return (
    <form
      className={
        bottom
          ? "sys-segment-form sys-segment-form--bottom"
          : "sys-segment-form"
      }
      noValidate
      onSubmit={(event) => void submit(event)}
    >
      <Field label="Name" error={nameError}>
        {(control) => (
          <input
            {...control}
            ref={field}
            type="text"
            autoComplete="off"
            spellCheck
            readOnly={saving}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
              setFailure(null);
            }}
          />
        )}
      </Field>
      <Field label="Kind">
        {(control) => (
          <select
            {...control}
            disabled={saving}
            value={kind}
            onChange={(event) => {
              kindTouched.current = true;
              setKind(event.target.value as SegmentKind);
            }}
          >
            {SEGMENT_KINDS.map((option) => (
              <option key={option} value={option}>
                {KIND_LABELS[option]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <p className="sys-segment-summary">{summary}</p>
      <InlineError message={failure} />
      <div className="sys-segment-actions">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabledReason={saving ? SAVING : undefined}
        >
          Save
        </Button>
      </div>
    </form>
  );
}

export function SaveSegmentCard(props: SaveSegmentCardProps) {
  const { form, open = true, onClose, ...rest } = props;
  const field = useRef<HTMLInputElement>(null);
  const content = (
    <SaveSegmentForm
      summary={rest.summary}
      defaultKind={rest.defaultKind}
      onSave={rest.onSave}
      onClose={onClose}
      field={field}
      bottom={form === "bottom"}
    />
  );
  if (form === "bottom") {
    return (
      <Sheet form="bottom" title={TITLE} open={open} onClose={onClose}>
        {content}
      </Sheet>
    );
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={TITLE}
      panelClassName="sys-segment-panel"
      initialFocusRef={field}
      anchor={{
        reason:
          "the card opens beside the selection it saves, so the clips being saved stay in view",
        ref: props.anchorRef as RefObject<HTMLElement | null>,
      }}
    >
      {content}
    </Dialog>
  );
}
