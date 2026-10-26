import { type SaveState, saveStateText } from "../stage/frame/saveState";

type AttentionControl =
  | { kind: "passive" }
  | { kind: "button"; activate: () => void };

type Props = {
  state: SaveState;
  attention: AttentionControl;
};

export function SaveStateDotView({ state, attention }: Props) {
  const text = saveStateText(state);
  const className = "save-dot";
  if (
    state.kind === "saving" ||
    state.kind === "saved" ||
    (state.kind === "failed" && attention.kind === "passive")
  ) {
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
      onClick={attention.kind === "button" ? attention.activate : undefined}
    />
  );
}
