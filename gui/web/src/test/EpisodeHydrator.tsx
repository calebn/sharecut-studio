import { type ReactNode, useLayoutEffect, useState } from "react";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useRecordHostStore } from "../record/hostStore";
import type { RecordSnapshot } from "../record/types";
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
  /** The host's record room, as the transport chip and the recording overlay read it. */
  record?: RecordSnapshot;
  /** JSON bodies for requests whose URL contains the key. Any other request gets a 503. */
  responses?: Record<string, unknown>;
  /** URLs containing one of these never answer, so a story can hold a loading state. */
  hang?: string[];
}

const NO_SERVER = JSON.stringify({ detail: "Storybook has no server." });

function installStubs(
  responses: Record<string, unknown>,
  hang: string[],
): () => void {
  const { fetch, WebSocket } = globalThis;
  globalThis.fetch = (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (hang.some((key) => url.includes(key))) return new Promise(() => {});
    const hit = Object.entries(responses).find(([key]) => url.includes(key));
    return Promise.resolve(
      new Response(hit ? JSON.stringify(hit[1]) : NO_SERVER, {
        status: hit ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
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
  const {
    project,
    role = "host",
    selection,
    state,
    record,
    responses,
    hang,
  } = config;
  useLayoutEffect(() => {
    const previous = useDawStore.getState();
    const previousRecord = useRecordHostStore.getState();
    const restoreStubs = installStubs(responses ?? {}, hang ?? []);
    registerDawCommands();
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
    if (record) {
      useRecordHostStore.getState().setSnapshot(record);
      useRecordHostStore.setState({ connected: true });
    }
    setReady(true);
    return () => {
      setReady(false);
      useDawStore.setState(previous, true);
      useRecordHostStore.setState(previousRecord, true);
      clearRegisteredCommands();
      restoreStubs();
    };
  }, [project, role, selection, state, record, responses, hang]);
  return ready ? children : null;
}
