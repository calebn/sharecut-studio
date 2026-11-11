import { createContext, useContext } from "react";

/** The bounce the host runs outside any stage; the live job snapshot comes from the store. */
export type BounceRun =
  | { kind: "idle" }
  | { kind: "running"; jobId: string | null; cancelling: boolean };

export const IDLE: BounceRun = { kind: "idle" };

export const BounceRunContext = createContext<BounceRun>(IDLE);

export function useBounceRun(): BounceRun {
  return useContext(BounceRunContext);
}
