import { create } from "zustand";

/** A yes/no question before an action, answered in the app's own dialog. */
export type ConfirmQuestion = {
  kind: "confirm";
  /** Names the action and its target, e.g. "Remove the guest track?". */
  title: string;
  /** The consequence, in human terms. */
  message: string;
  /** The safe choice, shown first and focused, e.g. "Keep track". */
  keepLabel: string;
  /** The action, shown last, e.g. "Remove track". */
  actionLabel: string;
  /** Danger styling for an action that discards work; primary otherwise. */
  danger: boolean;
};

/** A one-line text answer, such as a file path. */
export type TextQuestion = {
  kind: "text";
  title: string;
  label: string;
  hint?: string;
  submitLabel: string;
  /** Shown under the field when the person submits it empty. */
  requiredMessage: string;
};

export type Question = ConfirmQuestion | TextQuestion;

/** Go ahead (true, or the typed text) or back out (false or null). */
export type Answer = boolean | string | null;

export type PendingQuestion = {
  id: number;
  question: Question;
  settle: (answer: Answer) => void;
};

/** The one open question. `AskDialog` renders it; a newer question cancels it. */
export const useAskStore = create<{ pending: PendingQuestion | null }>(() => ({
  pending: null,
}));

let nextId = 0;

function open(question: Question, settle: (answer: Answer) => void): void {
  const previous = useAskStore.getState().pending;
  nextId += 1;
  useAskStore.setState({ pending: { id: nextId, question, settle } });
  previous?.settle(null);
}

/** True when the person chooses the action; false when they keep, cancel or close. */
export function askConfirm(
  question: Omit<ConfirmQuestion, "kind">,
): Promise<boolean> {
  return new Promise((resolve) =>
    open({ kind: "confirm", ...question }, (answer) =>
      resolve(answer === true),
    ),
  );
}

/** The trimmed text, or null when the person cancels or closes. */
export function askText(
  question: Omit<TextQuestion, "kind">,
): Promise<string | null> {
  return new Promise((resolve) =>
    open({ kind: "text", ...question }, (answer) =>
      resolve(
        typeof answer === "string" && answer.trim() ? answer.trim() : null,
      ),
    ),
  );
}

/** Settle question `id` if it is still open; a stale answer is ignored. */
export function answerQuestion(id: number, answer: Answer): void {
  const pending = useAskStore.getState().pending;
  if (pending?.id !== id) {
    return;
  }
  useAskStore.setState({ pending: null });
  pending.settle(answer);
}
