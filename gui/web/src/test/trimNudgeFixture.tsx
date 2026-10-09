import { useNudgeRun } from "../inspector/useNudgeRun";
import { field } from "./trimNudgeData";

export function Harness({ delta = -0.01 }: { delta?: number }) {
  const run = useNudgeRun();
  return <button {...run.buttonProps(field, delta, "Trim end")}>Nudge</button>;
}
