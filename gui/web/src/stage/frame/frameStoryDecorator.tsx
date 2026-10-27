import type { Decorator } from "@storybook/react-vite";

/**
 * The production `.stage-frame` around banner stories. `.stage-frame` is
 * `container: app / size`, so its height must stay definite or size
 * containment collapses it; the fixed `20rem` keeps it visible. The story goes
 * in the banner row and the empty `<main aria-label="Stage" />` stands in for
 * the stage body so the banner isn't the story's only landmark.
 */
export const frameStoryDecorator: Decorator = (Story, context) => {
  const phone = Boolean(context.parameters.framePhone);
  return (
    <div
      className={`stage-frame stage-frame--${phone ? "phone" : "desktop"}`}
      style={{ height: "20rem", width: phone ? "360px" : undefined }}
    >
      <div className="stage-frame-header" />
      <div className="stage-frame-banners">
        <Story />
      </div>
      <div className="stage-frame-alerts" />
      <main aria-label="Stage" className="stage-frame-body" />
    </div>
  );
};
