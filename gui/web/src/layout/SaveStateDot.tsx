import { useSaveState } from "../stage/frame/useSaveState";
import { SaveStateDotView } from "./SaveStateDotView";

/**
 * The host's project save state as a status light. Share guests see none:
 * their edits go through the review link.
 */
export function SaveStateDot() {
  const { state, attention } = useSaveState();
  if (!state) return null;
  return <SaveStateDotView state={state} attention={attention} />;
}
