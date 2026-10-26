import { Inspector } from "../inspector/Inspector";

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
