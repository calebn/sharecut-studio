import { useId, useRef, useState } from "react";
import { Button, Dialog, Field } from "../ui";
import type { Answer, ConfirmQuestion, Question, TextQuestion } from "./ask";

type Props = {
  question: Question | null;
  onAnswer: (answer: Answer) => void;
};

/**
 * The app's own confirm and text prompt, in place of `window.confirm` and
 * `window.prompt`. Keep (or Cancel) comes first and takes focus; the action
 * comes last. Escape, the scrim and Close all back out. On a phone it is a
 * bottom sheet with the actions pinned to the bottom bar.
 */
export function AskDialogView({ question, onAnswer }: Props) {
  if (!question) {
    return null;
  }
  return question.kind === "confirm" ? (
    <ConfirmView question={question} onAnswer={onAnswer} />
  ) : (
    <TextView question={question} onAnswer={onAnswer} />
  );
}

function ConfirmView({
  question,
  onAnswer,
}: {
  question: ConfirmQuestion;
  onAnswer: (answer: Answer) => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open
      phoneSheet
      title={question.title}
      panelClassName="ui-ask"
      initialFocusRef={keepRef}
      onClose={() => onAnswer(null)}
      footer={
        <div className="ui-ask-actions">
          <Button ref={keepRef} onClick={() => onAnswer(null)}>
            {question.keepLabel}
          </Button>
          <Button
            variant={question.danger ? "danger" : "primary"}
            onClick={() => onAnswer(true)}
          >
            {question.actionLabel}
          </Button>
        </div>
      }
    >
      <p className="ui-ask-message">{question.message}</p>
    </Dialog>
  );
}

function TextView({
  question,
  onAnswer,
}: {
  question: TextQuestion;
  onAnswer: (answer: Answer) => void;
}) {
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      phoneSheet
      title={question.title}
      panelClassName="ui-ask"
      initialFocusRef={inputRef}
      onClose={() => onAnswer(null)}
      footer={
        <div className="ui-ask-actions">
          <Button onClick={() => onAnswer(null)}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId}>
            {question.submitLabel}
          </Button>
        </div>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) {
            setError(question.requiredMessage);
            inputRef.current?.focus();
            return;
          }
          onAnswer(value);
        }}
      >
        <Field label={question.label} hint={question.hint} error={error}>
          {(control) => (
            <input
              {...control}
              ref={inputRef}
              value={value}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
