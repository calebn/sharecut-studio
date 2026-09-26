import { execute } from "../commands/execute";
import type { LayoutMode } from "../state/types";
import { useDaw } from "../state/useDaw";

const COMMAND: Record<Exclude<LayoutMode, "default">, string> = {
  timeline: "layout.timeline",
  text: "layout.text",
  review: "layout.review",
};

/**
 * Pane-local focus control: activates the matching focus mode, or returns to
 * default when that mode is already active.
 */
export function FocusToggle({
  mode,
  label,
}: {
  mode: Exclude<LayoutMode, "default">;
  label: string;
}) {
  const { layoutMode } = useDaw((s) => ({ layoutMode: s.layoutMode }));
  const active = layoutMode === mode;
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
          active ? "layout.default" : COMMAND[mode],
          {},
          { skipWhen: true },
        );
      }}
    >
      {active ? `Focused` : `Focus`}
    </button>
  );
}
