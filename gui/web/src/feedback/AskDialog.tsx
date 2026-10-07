import { useEffect } from "react";
import { AskDialogView } from "./AskDialogView";
import { answerQuestion, useAskStore } from "./ask";

/** Renders the open `askConfirm` / `askText` question. Mount once per app. */
export function AskDialog() {
  const pending = useAskStore((s) => s.pending);
  useEffect(
    () => () => {
      const open = useAskStore.getState().pending;
      if (open) answerQuestion(open.id, null);
    },
    [],
  );
  return (
    <AskDialogView
      key={pending?.id}
      question={pending?.question ?? null}
      onAnswer={(answer) => {
        if (pending) answerQuestion(pending.id, answer);
      }}
    />
  );
}
