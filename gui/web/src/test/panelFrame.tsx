import type { Decorator } from "@storybook/react-vite";

/**
 * The bottom-panel content area inside a real `.daw-shell`, which the panels' container
 * queries need. Set `parameters.dawShellPhone` for the 360 px phone frame and
 * `parameters.panelFrameTall` for a panel whose rows need more than the shell's
 * fixed bottom-panel row.
 */
export const panelFrame: Decorator = (Story, context) => {
  const phone = Boolean(context.parameters.dawShellPhone);
  const tall = Boolean(context.parameters.panelFrameTall);
  return (
    <div
      className={`daw-shell${phone ? " daw-shell--phone" : ""}`}
      style={{
        blockSize: tall ? "40rem" : "28rem",
        gridTemplateRows: tall ? "minmax(0, 1fr)" : undefined,
        inlineSize: phone ? "360px" : undefined,
      }}
    >
      <main className="tab-content" aria-label="Panel">
        <Story />
      </main>
    </div>
  );
};
