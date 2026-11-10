import { useMemo } from "react";
import { commitSeamRoll, seamRollLimits } from "../../../commands/seamRoll";

/**
 * Rolling a cut's seam from its pill in the Script. A roll needs clips that
 * abut, the rule the timeline draws a seam by; across a gap the pill has no
 * edges to drag, and none while another seam save is in flight. The roll's
 * token is read when the drag lets go, and a failed save is said in the
 * Script's status line.
 */
export function useScriptSeamRoll(say: (message: string) => void) {
  return useMemo(
    () => ({
      limits: seamRollLimits,
      commit: (id: string, deltaMs: number) => {
        void commitSeamRoll(id, deltaMs, say);
      },
    }),
    [say],
  );
}
