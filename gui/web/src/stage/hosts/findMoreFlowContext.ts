import { createContext, useContext } from "react";
import type { startPipelineRun } from "../../api";
import type { ModelNeeded } from "../../utils/apiError";

export const NO_TIER = "Set How tight in Prepare Cleanup first.";

/** The run Find more started, scoped to the project it ran on. */
export type FindMoreRun = {
  path: string;
  jobId: string | null;
  error: string | null;
};

export type FindMoreRequest = {
  path: string;
  epoch: number;
  options: NonNullable<Parameters<typeof startPipelineRun>[1]>;
};

export type FindMoreFlow = {
  run: FindMoreRun | null;
  setRun: (run: FindMoreRun | null) => void;
  /** The model Find more waits on in the open project; the Review queue shows its Get. */
  needs: ModelNeeded | null;
  /**
   * Waits for the model, then runs Find more again by itself, wherever the person is by then.
   * False when this model already ran Find more once since the last press, so the caller reports it.
   */
  stopFor: (need: ModelNeeded, request: FindMoreRequest) => boolean;
  /** A new press by the person: the next refusal waits again. */
  fresh: () => void;
};

const INERT: FindMoreFlow = {
  run: null,
  setRun: () => undefined,
  needs: null,
  stopFor: () => false,
  fresh: () => undefined,
};

export const Flow = createContext<FindMoreFlow>(INERT);

export function useFindMoreFlow(): FindMoreFlow {
  return useContext(Flow);
}
