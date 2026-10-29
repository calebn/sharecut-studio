import { createContext, useContext } from "react";
import type { ModelGate } from "../../models";
import type { BounceChoices } from "../../stages/deliver/bounceLogic";
import type { PipelineJobSnapshot } from "../../types/pipeline";

/** The bounce's own progress; the live job snapshot comes from the store. */
export type BounceRun =
  | { kind: "idle" }
  | {
      kind: "running";
      jobId: string | null;
      cancelling: boolean;
      cancelError: string | null;
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
  gate: ModelGate;
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
