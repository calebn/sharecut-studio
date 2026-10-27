import { useId, useRef } from "react";
import { Button, Dialog } from "../ui";
import type { Answer, ConfirmQuestion } from "./ask";

type Props = {
  question: ConfirmQuestion | null;
  onAnswer: (answer: Answer) => void;
};

/**
 * The app's own confirm prompt, in place of `window.confirm`. Keep (or Cancel)
 * comes first and takes focus; the action comes last. Escape, the scrim and Close all back out. On a phone it is a
 * bottom sheet with the actions pinned to the bottom bar.
 */
export function AskDialogView({ question, onAnswer }: Props) {
  if (!question) {
    return null;
  }
  return <ConfirmView question={question} onAnswer={onAnswer} />;
}

function ConfirmView({
  question,
  onAnswer,
}: {
  question: ConfirmQuestion;
  onAnswer: (answer: Answer) => void;
}) {
  const keepRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  return (
    <Dialog
      open
      title={question.title}
      descriptionId={messageId}
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
      <p id={messageId} className="ui-ask-message">
        {question.message}
      </p>
    </Dialog>
  );
}
