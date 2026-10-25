import type { Decorator } from "@storybook/react-vite";
import { EpisodeHydrator } from "./EpisodeHydrator";

/** Hydrates the shared fictional episode for a store-bound component and restores the store on unmount. */
export const withEpisode: Decorator = (Story, context) => (
  <EpisodeHydrator config={context.parameters.episode}>
    <Story />
  </EpisodeHydrator>
);
