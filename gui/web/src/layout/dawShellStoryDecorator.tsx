import type { Decorator } from "@storybook/react-vite";

/**
 * Production `.daw-shell` shell for banner stories. `.daw-shell` is
 * `container: app / size`, so its height must stay definite or size
 * containment collapses it — the fixed `20rem` here keeps it visible. The
 * empty `<main aria-label="Stage" />` sibling stands in for the shell's real
 * stage region so the banner isn't the story's only landmark.
 */
export const dawShellStoryDecorator: Decorator = (Story, context) => (
  <div
    className={`daw-shell${context.parameters.dawShellPhone ? " daw-shell--phone" : ""}`}
    style={{
      height: "20rem",
      width: context.parameters.dawShellPhone ? "360px" : undefined,
    }}
  >
    <Story />
    <main aria-label="Stage" />
  </div>
);
