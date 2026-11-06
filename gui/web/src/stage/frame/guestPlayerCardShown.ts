import type { ShellBreakpoint } from "../../state/types";
import type { StageId } from "../../types/stage";

/**
 * Guest Review carries the one Player in its expanded form at the top of the
 * center column (design-system element 4), so the frame leaves out the bar
 * there. A phone, and a window too short for the transcript, keep the bar.
 */
export const guestPlayerCardShown = (
  stage: StageId,
  shell: ShellBreakpoint,
  guest: boolean,
  short: boolean,
) => stage === "review" && guest && shell !== "phone" && !short;
