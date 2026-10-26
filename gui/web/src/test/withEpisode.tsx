import type { Decorator } from "@storybook/react-vite";
import { FeaturesContext } from "../extensions/FeaturesContext";
import {
  FEATURE_SHARE_UI_BANNER,
  FEATURE_SHARE_UI_MENU,
  FEATURE_SHARE_UI_ROUTES,
  FEATURE_TUNNEL_STATUS,
  GUEST_SHARE_FEATURES,
} from "../extensions/features";
import type { EpisodeRole } from "./episodeFixture";
import {
  type EpisodeParameters,
  episodeActive,
  hydrateEpisode,
} from "./hydrateEpisode";

const HOST_FEATURES = [
  FEATURE_SHARE_UI_ROUTES,
  FEATURE_SHARE_UI_BANNER,
  FEATURE_SHARE_UI_MENU,
  FEATURE_TUNNEL_STATUS,
];

type EpisodeStory = { episode?: EpisodeParameters };

export function episodeFeatures(role: EpisodeRole): string[] {
  return role === "host" ? HOST_FEATURES : GUEST_SHARE_FEATURES.features;
}

/** Hydrates the store and stubs the network before the story renders; Storybook runs the cleanup after it unmounts. */
export const episodeBeforeEach = ({
  parameters,
}: {
  parameters: EpisodeStory;
}) => hydrateEpisode(parameters.episode);

/** Offers the feature manifest the server would. Pair it with `episodeBeforeEach` on the same meta. */
export const withEpisode: Decorator = (Story, { parameters }) => {
  if (!episodeActive()) {
    throw new Error("withEpisode needs beforeEach: episodeBeforeEach.");
  }
  const { role = "host", features } = parameters.episode ?? {};
  return (
    <FeaturesContext.Provider
      value={{
        ready: true,
        manifest: {
          api_version: 1,
          features: features ?? episodeFeatures(role),
        },
      }}
    >
      <Story />
    </FeaturesContext.Provider>
  );
};
