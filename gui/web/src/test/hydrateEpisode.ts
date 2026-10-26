import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { useRecordHostStore } from "../record/hostStore";
import type { RecordSnapshot } from "../record/types";
import { useDawStore } from "../state/dawStore";
import type { DawState } from "../state/types";
import { resetFeedbackRepeatForTests } from "../state/uiSlice";
import type { ProjectView, Selection } from "../types/project";
import { resetQuestions } from "./ask";
import {
  type EpisodeRole,
  episode,
  ROLE_SHARE,
  selections,
} from "./episodeFixture";
import { FakeWebSocket } from "./fakeWebSocket";

export interface EpisodeParameters {
  project?: ProjectView;
  /** Defaults to the host, who opens the project by path. A guest opens `share:episode`. */
  role?: EpisodeRole;
  /** Feature ids the server offers; defaults to what the role gets in the app. */
  features?: string[];
  selection?: Selection;
  /** Store fields set after hydration (active tab, layout, pipeline job). */
  state?: Partial<DawState>;
  /** The host's record room, as the transport chip and the recording overlay read it. */
  record?: RecordSnapshot;
  /** JSON bodies by request path, or by `METHOD /path` for one method. Any other request gets a 503. */
  responses?: Record<string, unknown>;
  /** Requests to these paths (`/path` or `METHOD /path`) never answer, so a story can hold a loading state. */
  hang?: string[];
}

const NO_SERVER = JSON.stringify({ detail: "Storybook has no server." });

interface LiveEpisode {
  base: { fetch: typeof fetch; WebSocket: typeof WebSocket };
  restoreState: () => void;
}

let live: LiveEpisode | null = null;

/** True between `hydrateEpisode` and the cleanup of the episode it set up. */
export function episodeActive(): boolean {
  return live !== null;
}

function requestKeys(input: Parameters<typeof fetch>[0], init?: RequestInit) {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = (
    init?.method ?? (input instanceof Request ? input.method : "GET")
  ).toUpperCase();
  const path = new URL(url, globalThis.location.href).pathname;
  return [`${method} ${path}`, path];
}

function installStubs(
  responses: Record<string, unknown>,
  hang: string[],
): { abortHanging: () => void } {
  const hanging = new Set<() => void>();
  globalThis.fetch = (input, init) => {
    const keys = requestKeys(input, init);
    if (hang.some((key) => keys.includes(key)))
      return new Promise((_resolve, reject) => {
        const abort = () =>
          reject(new DOMException("The request was aborted.", "AbortError"));
        hanging.add(abort);
        init?.signal?.addEventListener("abort", abort, { once: true });
      });
    const key = keys.find((candidate) => candidate in responses);
    return Promise.resolve(
      new Response(key ? JSON.stringify(responses[key]) : NO_SERVER, {
        status: key ? 200 : 503,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  FakeWebSocket.reset({ autoOpen: false });
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  return {
    abortHanging: () => {
      for (const abort of hanging) abort();
      hanging.clear();
    },
  };
}

function snapshotLocalStorage(): () => void {
  const entries = Object.entries(globalThis.localStorage);
  return () => {
    globalThis.localStorage.clear();
    for (const [key, value] of entries) {
      globalThis.localStorage.setItem(key, value);
    }
  };
}

/**
 * Fill the DAW store and stub the network the way the live app finds them for
 * one episode, and return the cleanup. Run it from a story's `beforeEach` so
 * Storybook calls the cleanup after the story unmounts.
 *
 * Storybook starts the next story's `beforeEach` before it runs the previous
 * story's cleanup. A hydration therefore first resets the state an earlier
 * episode left, keeping the stubs in place so a late request still meets one,
 * and a cleanup that finds a newer episode in place only aborts its own
 * hanging requests.
 */
export function hydrateEpisode(
  config: EpisodeParameters = {},
): () => Promise<void> {
  const base = live?.base ?? {
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
  };
  live?.restoreState();
  const { project, role = "host", selection, state, record } = config;
  const previous = useDawStore.getState();
  const previousRecord = useRecordHostStore.getState();
  const restoreStorage = snapshotLocalStorage();
  const stubs = installStubs(config.responses ?? {}, config.hang ?? []);
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
  const restoreState = () => {
    stubs.abortHanging();
    useDawStore.setState(previous, true);
    useRecordHostStore.setState(previousRecord, true);
    clearRegisteredCommands();
    resetQuestions();
    resetFeedbackRepeatForTests();
    restoreStorage();
  };
  const episodeLive: LiveEpisode = { base, restoreState };
  live = episodeLive;
  return async () => {
    stubs.abortHanging();
    if (live !== episodeLive) return;
    restoreState();
    // A story that is still mounted reacts to the reset and the sends queued behind an aborted request run
    // on the next task; both must still meet the stub.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (live !== episodeLive) return;
    live = null;
    globalThis.fetch = base.fetch;
    globalThis.WebSocket = base.WebSocket;
  };
}
