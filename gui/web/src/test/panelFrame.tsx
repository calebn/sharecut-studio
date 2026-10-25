import type { Decorator } from "@storybook/react-vite";

/**
 * The bottom-panel content area inside a real `.daw-shell`, which the panels' container
 * queries need. Set `parameters.dawShellPhone` for the 360 px phone frame.
 */
export const panelFrame: Decorator = (Story, context) => {
  const phone = Boolean(context.parameters.dawShellPhone);
  return (
    <div
      className={`daw-shell${phone ? " daw-shell--phone" : ""}`}
      style={{ blockSize: "28rem", inlineSize: phone ? "360px" : undefined }}
    >
      <main className="tab-content" aria-label="Panel">
        <Story />
      </main>
    </div>
  );
};
