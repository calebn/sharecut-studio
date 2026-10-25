import type { Decorator } from "@storybook/react-vite";
import { type ReactNode, useLayoutEffect, useState } from "react";
import { useDawStore } from "../state/dawStore";
import type { DawState } from "../state/types";
import type { ProjectView, Selection } from "../types/project";
import {
  type EpisodeRole,
  episode,
  ROLE_SHARE,
  selections,
} from "./episodeFixture";
import { FakeWebSocket } from "./fakeWebSocket";

export interface EpisodeParameters {
  /** Defaults to the shared episode. */
  project?: ProjectView;
  /** Defaults to the host, who opens the project by path. A guest opens `share:episode`. */
  role?: EpisodeRole;
  selection?: Selection;
  /** Store fields set after hydration (active tab, layout, pipeline job). */
  state?: Partial<DawState>;
}

const NO_SERVER = JSON.stringify({ detail: "Storybook has no server." });

function installStubs(): () => void {
  const { fetch, WebSocket } = globalThis;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(NO_SERVER, {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
  FakeWebSocket.reset({ autoOpen: false });
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return () => {
    globalThis.fetch = fetch;
    globalThis.WebSocket = WebSocket;
  };
}

export function EpisodeHydrator({
  config = {},
  children,
}: {
  config?: EpisodeParameters;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(false);
  const { project, role = "host", selection, state } = config;
  useLayoutEffect(() => {
    const previous = useDawStore.getState();
    const restoreStubs = installStubs();
    const { guestMode, capabilities } = ROLE_SHARE[role];
    const episodeProject = project ?? episode();
    previous.hydrate(
      guestMode === null ? episodeProject.project_path : "share:episode",
      episodeProject,
    );
    useDawStore.setState({
      guestMode,
      shareCapabilities: capabilities,
      ...state,
    });
    useDawStore.getState().setSelection(selection ?? selections.none);
    setReady(true);
    return () => {
      setReady(false);
      useDawStore.setState(previous, true);
      restoreStubs();
    };
  }, [project, role, selection, state]);
  return ready ? children : null;
}

/** Hydrates the shared fictional episode for a store-bound component and restores the store on unmount. */
export const withEpisode: Decorator = (Story, context) => (
  <EpisodeHydrator config={context.parameters.episode}>
    <Story />
  </EpisodeHydrator>
);
