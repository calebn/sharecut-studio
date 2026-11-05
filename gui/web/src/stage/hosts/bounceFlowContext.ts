import { createContext, useContext } from "react";
import type { BounceChoices } from "../../stages/deliver/bounceLogic";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import type { ExactRangeTarget } from "../../types/project";
import type { ModelNeeded } from "../../utils/apiError";

/** The bounce's own progress; the live job snapshot comes from the store. */
export type BounceRun =
  | { kind: "idle" }
  | {
      kind: "running";
      jobId: string | null;
      cancelling: boolean;
      cancelError: string | null;
      /** The range this run captured at start; null for a bounce without one. */
      range: ExactRangeTarget | null;
    }
  | { kind: "done"; paths: string[] }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled"; paths: string[] };

export type BounceFlow = {
  run: BounceRun;
  /** The live job while the run follows one. */
  job: PipelineJobSnapshot | null;
  choices: BounceChoices;
  setChoices: (next: BounceChoices) => void;
  /** The model a start stopped on; the Deliver page shows its Get and the bounce resumes when it lands. */
  needs: ModelNeeded | null;
  /** Bounces what the choices, the selection, the solo set and the fixed range say. Ignored while one runs. */
  start: () => void;
  cancel: () => void;
  /** Back to idle after a failure or cancel. */
  again: () => void;
};

export const Flow = createContext<BounceFlow | null>(null);

export function useBounceFlow(): BounceFlow {
  const flow = useContext(Flow);
  if (!flow) {
    throw new Error("useBounceFlow needs a BounceFlowProvider above it.");
  }
  return flow;
}
