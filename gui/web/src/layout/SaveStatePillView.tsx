import { pillClassName } from "../ui";
import { SAVE_PILL_COPY, type SaveState, saveStateText } from "./saveState";

type Props = {
  state: SaveState;
  /** Waiting: send the queued edits now. */
  onSendNow: () => void;
  /** Failed, refused: take the person to the reason. */
  onSeeWhy: () => void;
  /** Failed, unreadable: read the saved edits again. */
  onRetry: () => void;
};

/**
 * One status pill for the project's save state. Saving and saved are read-only;
 * a state the person can act on is a button that carries the action.
 */
export function SaveStatePillView({
  state,
  onSendNow,
  onSeeWhy,
  onRetry,
}: Props) {
  const text = saveStateText(state);
  if (state.kind === "saving" || state.kind === "saved") {
    return (
      <span
        className={pillClassName("neutral", "save-state")}
        data-save-state={state.kind}
        aria-busy={state.kind === "saving" || undefined}
      >
        {text}
      </span>
    );
  }
  const [title, onClick] =
    state.kind === "waiting"
      ? [SAVE_PILL_COPY.waitingTitle, onSendNow]
      : state.cause === "refused"
        ? [state.reason, onSeeWhy]
        : [SAVE_PILL_COPY.unreadableTitle, onRetry];
  return (
    <button
      type="button"
      className={pillClassName("warning", "pill--action", "save-state")}
      data-save-state={state.kind}
      title={title}
      onClick={onClick}
    >
      {text}
    </button>
  );
}
