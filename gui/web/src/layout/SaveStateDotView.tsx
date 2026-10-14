import { type SaveState, saveStateText } from "./saveState";

type Props = {
  state: SaveState;
  /** Waiting or failed: take the person to the Needs attention banner. */
  onShowAttention: () => void;
};

/**
 * The project's save state as a status light. Colour is never the only cue:
 * saved is a solid circle, saving a ring, waiting a hollow circle and failed a
 * square. Waiting and failed are buttons that go to the Needs attention banner,
 * which carries the text and the actions.
 */
export function SaveStateDotView({ state, onShowAttention }: Props) {
  const text = saveStateText(state);
  const className = "save-dot";
  if (state.kind === "saving" || state.kind === "saved") {
    return (
      <span
        role="img"
        className={className}
        data-save-state={state.kind}
        aria-label={text}
        aria-busy={state.kind === "saving" || undefined}
        title={text}
      />
    );
  }
  return (
    <button
      type="button"
      className={className}
      data-save-state={state.kind}
      aria-label={text}
      title={text}
      onClick={onShowAttention}
    />
  );
}
