import { execute } from "../commands/execute";
import type { FocusMode } from "../state/types";
import { useDaw } from "../state/useDaw";

const COMMAND: Record<Exclude<FocusMode, "default">, string> = {
  timeline: "focus.timeline",
  text: "focus.text",
  review: "focus.review",
};

/**
 * Pane-local focus control: activates the matching focus mode, or returns to
 * default when that mode is already active.
 */
export function FocusToggle({
  mode,
  label,
}: {
  mode: Exclude<FocusMode, "default">;
  label: string;
}) {
  const { focusMode } = useDaw((s) => ({ focusMode: s.focusMode }));
  const active = focusMode === mode;
  return (
    <button
      type="button"
      className={`ui-control focus-pane-btn${active ? " active" : ""}`}
      title={
        active ? `Exit ${label} focus (balanced layout)` : `Focus ${label}`
      }
      aria-pressed={active}
      onClick={() => {
        void execute(
          active ? "focus.default" : COMMAND[mode],
          {},
          { skipWhen: true },
        );
      }}
    >
      {active ? `Focused` : `Focus`}
    </button>
  );
}
