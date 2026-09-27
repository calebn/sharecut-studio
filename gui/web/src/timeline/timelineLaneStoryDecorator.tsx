import type { Decorator } from "@storybook/react-vite";

/** Production lane shell for prop-only overlay stories at desktop or phone width. */
export const timelineLaneStoryDecorator: Decorator = (Story, context) => (
  <main className="timeline-area" aria-label="Timeline lane preview">
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
