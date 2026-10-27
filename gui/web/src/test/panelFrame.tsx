import type { Decorator } from "@storybook/react-vite";

/**
 * A panel inside a real `.stage-frame` body, which the panels' container
 * queries need. Set `parameters.framePhone` for the 360 px phone frame and
 * `parameters.panelFrameTall` for a panel whose rows need more than the default
 * height.
 */
export const panelFrame: Decorator = (Story, context) => {
  const phone = Boolean(context.parameters.framePhone);
  const tall = Boolean(context.parameters.panelFrameTall);
  return (
    <div
      className={`stage-frame stage-frame--${phone ? "phone" : "desktop"}`}
      style={{
        blockSize: tall ? "40rem" : "28rem",
        gridTemplateRows: "minmax(0, 1fr)",
        inlineSize: phone ? "360px" : undefined,
      }}
    >
      <main className="stage-frame-body" aria-label="Panel">
        <Story />
      </main>
    </div>
  );
};
