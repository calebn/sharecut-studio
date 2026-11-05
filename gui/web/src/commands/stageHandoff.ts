import { registerCommand } from "./execute";

export type StageHandoffAction = {
  /** Why the hand-off cannot run now; absent when it can. */
  disabledReason?: string;
  run: () => void;
};

let current: StageHandoffAction | null = null;

/** The open stage's hand-off button, for Mod+Enter. Returns the cleanup that withdraws it. */
export function offerStageHandoff(action: StageHandoffAction): () => void {
  current = action;
  return () => {
    if (current === action) current = null;
  };
}

export function registerStageHandoffCommand(): void {
  registerCommand("stage.handoff", () => {
    if (!current) return { status: "ok" };
    if (current.disabledReason) {
      return { status: "disabled", reason: current.disabledReason };
    }
    current.run();
    return { status: "ok" };
  });
}
