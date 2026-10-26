import type { Decorator } from "@storybook/react-vite";
import { EpisodeHydrator } from "./EpisodeHydrator";

export const withEpisode: Decorator = (Story, context) => (
  <EpisodeHydrator config={context.parameters.episode}>
    <Story />
  </EpisodeHydrator>
);
