import type { ExecuteResult } from "./types";

export type ClipHandleKind = "fade" | "trim";
export type ClipHandleAction =
  /**
   * One arrow step; `held` for the key's auto-repeat, which stops at a soft
   * boundary as a held strip nudge does (`edit/nudge.ts` `nudgeStep`).
   */
  | { phase: "nudge"; direction: -1 | 1; shift: boolean; held: boolean }
  | { phase: "finish"; key?: "ArrowLeft" | "ArrowRight" };

export type FocusedClipHandle = {
  kind: ClipHandleKind;
  run(action: ClipHandleAction): ExecuteResult | Promise<ExecuteResult>;
  cancel(): void;
};

let focused: FocusedClipHandle | null = null;

export function registerFocusedClipHandle(
  session: FocusedClipHandle,
): () => void {
  focused?.cancel();
  focused = session;
  return () => {
    if (focused === session) focused = null;
  };
}

export function focusedClipHandleKind(): ClipHandleKind | null {
  return focused?.kind ?? null;
}

export function runFocusedClipHandle(
  kind: ClipHandleKind,
  args: Record<string, unknown>,
): ExecuteResult | Promise<ExecuteResult> {
  if (focused?.kind !== kind) {
    return { status: "disabled", reason: "Focus a clip handle first" };
  }
  if (
    args.phase === "nudge" &&
    (args.direction === -1 || args.direction === 1) &&
    typeof args.shift === "boolean" &&
    typeof args.held === "boolean"
  ) {
    return focused.run({
      phase: "nudge",
      direction: args.direction,
      shift: args.shift,
      held: args.held,
    });
  }
  if (
    args.phase === "finish" &&
    (args.key === undefined ||
      args.key === "ArrowLeft" ||
      args.key === "ArrowRight")
  ) {
    return focused.run({ phase: "finish", key: args.key });
  }
  return { status: "disabled", reason: "Invalid clip handle action" };
}
