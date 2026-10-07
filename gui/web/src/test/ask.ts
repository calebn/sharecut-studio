import {
  type Answer,
  answerQuestion,
  type PendingQuestion,
  type Question,
  useAskStore,
} from "../feedback/ask";

const stops = new Set<() => void>();

/**
 * Answer every `askConfirm` / `askText` question with `reply` (true goes
 * ahead, null backs out, a string is typed text) and record each question.
 * Setup stops it after the test.
 */
export function answerQuestions(
  reply: Answer | ((question: Question) => Answer),
) {
  const asked: Question[] = [];
  const handle = (pending: PendingQuestion) => {
    asked.push(pending.question);
    answerQuestion(
      pending.id,
      typeof reply === "function" ? reply(pending.question) : reply,
    );
  };
  const open = useAskStore.getState().pending;
  if (open) handle(open);
  const stop = useAskStore.subscribe((s) => {
    if (s.pending) handle(s.pending);
  });
  stops.add(stop);
  return { asked };
}

/** Called by setup after each test: stop auto-answers and drop any open question. */
export function resetQuestions(): void {
  for (const stop of stops) stop();
  stops.clear();
  const open = useAskStore.getState().pending;
  if (open) answerQuestion(open.id, null);
}
