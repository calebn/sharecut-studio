import { Inspector } from "../inspector/Inspector";

/** The production inspector in a rail-width column, as the desktop shell places it. */
export function InspectorRailStory({
  placement = "rail",
}: {
  placement?: "rail" | "sheet";
}) {
  return (
    <div
      style={{
        inlineSize: "var(--inspector-width)",
        blockSize: "40rem",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <Inspector placement={placement} />
    </div>
  );
}
