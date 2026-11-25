import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { SegmentKind } from "../../api";
import { segmentSaveMessage } from "../../edit/segmentSaveMessages";
import { SEGMENT_KINDS } from "../../edit/segmentSelection";
import { Button, Field } from "../../ui";
import { InlineError } from "../../ui/InlineError";
import { SegmentCardFrame } from "./SegmentCardFrame";
import { useCrampedSheet } from "./useCrampedSheet";

const TITLE = "Save as segment";
const NAME_REQUIRED = "Enter a name for the segment.";
const SAVING = "Saving to your library.";
const NAME_MAX = 100;

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

type FormState = {
  name: string;
  setName: (value: string) => void;
  kind: SegmentKind;
  pickKind: (value: SegmentKind) => void;
  nameError: string | null;
  failure: string | null;
  saving: boolean;
  submit: (event: FormEvent) => Promise<void>;
  clearMessages: () => void;
};

function useSaveForm(
  { defaultKind, onSave, onClose }: Common,
  field: RefObject<HTMLInputElement | null>,
): FormState & { busy: RefObject<boolean> } {
  const busy = useRef(false);
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
    busy.current = true;
    setSaving(true);
    setNameError(null);
    setFailure(null);
    try {
      await onSave({ name: trimmed, kind });
      busy.current = false;
      onClose();
    } catch (error) {
      setFailure(segmentSaveMessage(error));
      saveInFlight.current = false;
      busy.current = false;
      setSaving(false);
      field.current?.focus();
    }
  };

  return {
    busy,
    name,
    setName,
    kind,
    pickKind: (value) => {
      kindTouched.current = true;
      setKind(value);
    },
    nameError,
    failure,
    saving,
    submit,
    clearMessages: () => {
      setNameError(null);
      setFailure(null);
    },
  };
}

function SaveActions({
  saving,
  onClose,
  formId,
}: {
  saving: boolean;
  onClose: () => void;
  formId: string;
}) {
  return (
    <div className="sys-segment-actions">
      <Button
        type="button"
        onClick={onClose}
        disabledReason={saving ? SAVING : undefined}
      >
        Cancel
      </Button>
      <Button
        type="submit"
        form={formId}
        variant="primary"
        disabledReason={saving ? SAVING : undefined}
      >
        Save
      </Button>
    </div>
  );
}

function SaveSegmentForm({
  summary,
  onClose,
  field,
  bottom,
  pinned,
  formId,
  state,
}: Pick<Common, "summary" | "onClose"> & {
  formId: string;
  pinned: boolean;
  field: RefObject<HTMLInputElement | null>;
  bottom: boolean;
  state: FormState;
}) {
  const { name, kind, nameError, failure, saving } = state;

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

  return (
    <form
      id={formId}
      className={
        bottom
          ? "sys-segment-form sys-segment-form--bottom"
          : "sys-segment-form"
      }
      noValidate
      onSubmit={(event) => void state.submit(event)}
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
            maxLength={NAME_MAX}
            value={name}
            onChange={(event) => {
              state.setName(event.target.value);
              state.clearMessages();
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
            onChange={(event) =>
              state.pickKind(event.target.value as SegmentKind)
            }
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
      {saving ? (
        <p className="sys-segment-summary" role="status">
          {SAVING}
        </p>
      ) : null}
      <InlineError message={failure} />
      {pinned ? null : (
        <SaveActions saving={saving} onClose={onClose} formId={formId} />
      )}
    </form>
  );
}

export function SaveSegmentCard(props: SaveSegmentCardProps) {
  const { open = true } = props;
  const field = useRef<HTMLInputElement>(null);
  const state = useSaveForm(props, field);
  const { busy } = state;
  const formId = useId();
  const cramped = useCrampedSheet();
  const pinned = props.form === "bottom" && !cramped;
  const close = () => {
    if (!busy.current) props.onClose();
  };
  const content = (
    <SaveSegmentForm
      summary={props.summary}
      onClose={close}
      formId={formId}
      field={field}
      bottom={props.form === "bottom"}
      pinned={pinned}
      state={state}
    />
  );
  const frame = {
    title: TITLE,
    open,
    busy,
    onClose: props.onClose,
    initialFocusRef: field,
  };
  return props.form === "bottom" ? (
    <SegmentCardFrame
      {...frame}
      form="bottom"
      footer={
        pinned ? (
          <SaveActions saving={state.saving} onClose={close} formId={formId} />
        ) : undefined
      }
    >
      {content}
    </SegmentCardFrame>
  ) : (
    <SegmentCardFrame {...frame} anchorRef={props.anchorRef}>
      {content}
    </SegmentCardFrame>
  );
}
