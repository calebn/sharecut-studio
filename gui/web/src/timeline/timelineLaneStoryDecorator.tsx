import type { Decorator } from "@storybook/react-vite";

/** Production lane shell for prop-only overlay stories at desktop or phone width. */
export const timelineLaneStoryDecorator: Decorator = (Story, context) => {
  const label = context.parameters.lanePreviewLabel;
  const previewLabel =
    typeof label === "string" && label.trim() ? label : "Timeline lane preview";
  return (
    <main className="timeline-area" aria-label={previewLabel}>
      <div
        className="lane-row"
        style={{ width: context.parameters.phoneWidth ? "360px" : "40rem" }}
      >
        <div className="lane-inner" style={{ width: "100%" }}>
          <Story />
        </div>
      </div>
    </main>
  );
};
