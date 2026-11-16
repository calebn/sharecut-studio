import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { loadReviewBootstrap } from "./api";
import {
  classifyBootstrapFailure,
  type GuestLoadFailure,
  guestLoadCover,
} from "./guestLoadFailure";
import { ApiError } from "./utils/apiError";
import { readNotServed } from "./utils/notServed";
import "./styles/daw.css";
import { FeatureProvider } from "./extensions/FeatureProvider";
import {
  useFeaturesReady,
  useHasFeature,
  useRetryFeatures,
} from "./extensions/FeaturesContext";
import { FEATURE_SHARE_UI_ROUTES } from "./extensions/features";
import { AskDialog } from "./feedback/AskDialog";
import { ModelsProvider } from "./models";
import {
  clearOfflineSnapshot,
  loadOfflineSnapshot,
} from "./services/offlineQueue/offlineStore";
import { isShareProjectKey, shareProjectKey } from "./shareMode";
import { parseShareRoute } from "./shareRoute";
import { GuestLoadingScreen } from "./stage/frame/GuestLoadingScreen";
import { StageLoading } from "./stage/frame/StageLoading";
import { GuestPageCover, NotServedCover } from "./stage/frame/StatusCovers";
import { HomeScreen } from "./stages/home/HomeScreen";
import { DawProvider } from "./state/store";
import type { ProjectView } from "./types/project";
import { ErrorScreen } from "./ui";
import { peekOpenStage } from "./utils/openIntent";
import { projectNameFromPath } from "./utils/projectUrl";

void import("./dawApp");

const DawApp = lazy(() =>
  import("./dawApp").then((m) => ({ default: m.DawApp })),
);

const GuestRoomApp = lazy(() =>
  import("./record/GuestRoomApp").then((m) => ({ default: m.GuestRoomApp })),
);

function projectPathFromQuery(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("project");
}

function shareRouteFromLocation(): {
  kind: "review" | "record";
  token: string;
} | null {
  const parsed = parseShareRoute(window.location.pathname);
  if (parsed) {
    return parsed;
  }
  const params = new URLSearchParams(window.location.search);
  const review = params.get("review");
  return review ? { kind: "review", token: review } : null;
}

type BootstrapError =
  | { failure: GuestLoadFailure }
  | { message: string; hint?: string };
type GuestAccess = {
  key: string;
  mode: string;
  capabilities: string[] | null;
  transcriptWords: boolean;
  author: string | null;
};
type CachedGuestProject = { key: string; project: ProjectView };
type BootstrapRequest = {
  projectPath: string | null;
  reviewToken: string | null;
  recordToken: string | null;
  featuresReady: boolean;
  shareRoutesEnabled: boolean;
  attempt: number;
};
type BootstrapObservation = {
  request: BootstrapRequest;
  status: "pending" | "settled";
  guest: GuestAccess | null;
  cached: CachedGuestProject | null;
  error: BootstrapError | null;
};
type BootstrapOutcome =
  | { kind: "online"; guest: GuestAccess }
  | { kind: "cached"; guest: GuestAccess; cached: CachedGuestProject }
  | { kind: "error"; error: BootstrapError };

function sameRequest(a: BootstrapRequest, b: BootstrapRequest) {
  return (
    a.projectPath === b.projectPath &&
    a.reviewToken === b.reviewToken &&
    a.recordToken === b.recordToken &&
    a.featuresReady === b.featuresReady &&
    a.shareRoutesEnabled === b.shareRoutesEnabled &&
    a.attempt === b.attempt
  );
}

/** How long a cover with no automatic retry counts an unanswered attempt as trying. */
const ATTEMPT_PATIENCE_MS = 30_000;

/** Attempts for one link kept in flight: the newest and the two before it. */
const MAX_ATTEMPTS_IN_FLIGHT = 3;

function abortAll(flight: AbortController[]) {
  for (const controller of flight.splice(0)) controller.abort();
}

type Standing = "newest" | "replaced" | "gone";

/**
 * What an attempt's outcome does to the observation. A replaced attempt (a
 * later attempt for the same link took over) is not thrown away: its answer
 * with the episode opens it, unless the episode is already open or the
 * failure now held says the link is gone (an older answer must not reopen what
 * the newest one found dead), and nothing else it says counts. Pending or
 * settled does not matter: a newer attempt that failed fast leaves nothing
 * pending while an older, slower one is still on its way. Once the episode is
 * open the other attempts are aborted, but one that answers anyway can only
 * refresh it (the newest) and a failure or saved copy never covers it.
 */
function settleBootstrap(
  state: BootstrapObservation,
  request: BootstrapRequest,
  standing: Standing,
  completed: BootstrapOutcome | null,
): BootstrapObservation {
  const token = request.reviewToken;
  if (standing === "gone" || token === null) return state;
  const open = state.guest?.key === shareProjectKey(token);
  if (standing === "replaced") {
    const gone =
      state.error !== null &&
      "failure" in state.error &&
      state.error.failure.kind === "bad-link";
    return completed?.kind === "online" && !open && !gone
      ? { ...state, status: "settled", guest: completed.guest, error: null }
      : state;
  }
  if (state.request !== request) return state;
  if (completed?.kind === "online") {
    return { ...state, status: "settled", guest: completed.guest, error: null };
  }
  if (open) return { ...state, status: "settled" };
  if (completed?.kind === "cached") {
    return {
      ...state,
      status: "settled",
      guest: completed.guest,
      cached: completed.cached,
      error: null,
    };
  }
  if (completed?.kind === "error") {
    return { ...state, status: "settled", error: completed.error };
  }
  return { ...state, status: "settled" };
}

function admitBootstrap(
  request: BootstrapRequest,
  previous: BootstrapObservation | null,
): BootstrapObservation {
  const retained: BootstrapObservation = previous
    ? { ...previous, request }
    : {
        request,
        status: request.reviewToken ? "pending" : "settled",
        guest: null,
        cached: null,
        error: null,
      };
  if (!request.featuresReady) return retained;
  if (
    (request.reviewToken || request.recordToken) &&
    !request.shareRoutesEnabled
  ) {
    return {
      ...retained,
      status: "settled",
      error: request.reviewToken
        ? { failure: { kind: "no-review-routes" } }
        : {
            message:
              "Share / guest routes (review and record) are not available (online extension not loaded).",
          },
    };
  }
  if (request.recordToken) {
    return { ...retained, status: "settled", guest: null, error: null };
  }
  // A new attempt for the same review link keeps showing why the last one
  // failed, so the cover and its button stay on screen while it runs.
  const holdsError =
    request.reviewToken !== null &&
    previous?.request.reviewToken === request.reviewToken &&
    previous.request.featuresReady === request.featuresReady;
  return {
    ...retained,
    status: request.reviewToken ? "pending" : "settled",
    error: holdsError ? retained.error : null,
  };
}

function AppInner() {
  const shareRoute = shareRouteFromLocation();
  const reviewToken = shareRoute?.kind === "review" ? shareRoute.token : null;
  const recordToken = shareRoute?.kind === "record" ? shareRoute.token : null;
  const featuresReady = useFeaturesReady();
  const retryFeatures = useRetryFeatures();
  const shareRoutesEnabled = useHasFeature(FEATURE_SHARE_UI_ROUTES);
  const projectPath = projectPathFromQuery();
  const [attempt, setAttempt] = useState(0);
  const input: BootstrapRequest = {
    projectPath,
    reviewToken,
    recordToken,
    featuresReady,
    shareRoutesEnabled,
    attempt,
  };
  const [bootstrap, setBootstrap] = useState(() => admitBootstrap(input, null));
  let current = bootstrap;
  if (!sameRequest(bootstrap.request, input)) {
    current = admitBootstrap(input, bootstrap);
    setBootstrap(current);
  }
  const { request, guest, cached: cachedGuestProject, error } = current;
  const shareKey = guest?.key ?? null;
  const guestMode = guest?.mode ?? null;
  const shareCapabilities = guest?.capabilities ?? null;
  const shareTranscriptWords = guest?.transcriptWords ?? false;
  const shareAuthor = guest?.author ?? null;
  const shareBootstrapping = current.status === "pending";
  // A hung features call is not a dead button: asking again replaces it.
  const retry = () => {
    if (!featuresReady) retryFeatures();
    setAttempt((n) => n + 1);
  };
  const projectLoading = () =>
    reviewToken || shareKey || isShareProjectKey(projectPath ?? "") ? (
      <GuestLoadingScreen label="Loading project…" onRetry={retry} />
    ) : (
      <StageLoading
        stage={
          (projectPath && peekOpenStage(projectPath)) ||
          (reviewToken ? "review" : "prepare")
        }
        name={projectPath ? projectNameFromPath(projectPath) : undefined}
        onRetry={() => window.location.reload()}
      />
    );

  const autoRetryMs =
    error && "failure" in error
      ? guestLoadCover(error.failure).autoRetryMs
      : null;

  // A cover that retries by itself replaces a hung attempt at its delay. One
  // that does not would leave a pressed button "Trying…" for good, so an
  // attempt still unanswered after the patience stops counting as trying: the
  // button returns and can be pressed again. The attempt stays in flight and is
  // judged like any other when it answers.
  const [stalledAttempt, setStalledAttempt] = useState<number | null>(null);
  const waiting = shareBootstrapping && error !== null && autoRetryMs === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(
      () => setStalledAttempt(attempt),
      ATTEMPT_PATIENCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [waiting, attempt]);
  const trying =
    shareBootstrapping && error !== null && stalledAttempt !== attempt;

  // Counts from the start of each attempt and keeps counting while one is in
  // flight: the request has no timeout, so a hung attempt is replaced after the
  // delay instead of ending the retries. A press starts a new attempt, and so
  // a new count.
  useEffect(() => {
    if (autoRetryMs === null) return;
    const timer = window.setTimeout(
      () => setAttempt((n) => n + 1),
      autoRetryMs,
    );
    return () => window.clearTimeout(timer);
  }, [autoRetryMs, attempt]);

  // Tells an attempt whether a later one for the same link replaced it, or the
  // link changed or the page left (the effect's cleanup runs for both, so it
  // cannot tell them apart). The generation moves whenever the link does, so an
  // attempt for a link the guest left and came back to stays gone.
  // It also owns each attempt's AbortController. A request has no timeout, so
  // a host that hangs would otherwise collect one open request per retry and
  // use up the browser's connections to it, and a host that came back would
  // stay unreachable. At most MAX_ATTEMPTS_IN_FLIGHT are kept: the newest and
  // the ones before it, so a slow host can still answer a replaced attempt.
  const attempts = useRef<{
    newest: BootstrapRequest | null;
    link: string;
    generation: number;
    flight: AbortController[];
  }>({ newest: null, link: "", generation: 0, flight: [] });
  useEffect(() => {
    const link = `${request.reviewToken}|${request.recordToken}|${request.featuresReady}|${request.shareRoutesEnabled}`;
    const now = attempts.current;
    if (link !== now.link) {
      now.link = link;
      now.generation += 1;
      abortAll(now.flight);
    }
    now.newest = request;
    return () => {
      now.newest = null;
    };
  }, [request]);

  useEffect(() => {
    const tracker = attempts.current;
    return () => abortAll(tracker.flight);
  }, []);

  useEffect(() => {
    const { featuresReady, shareRoutesEnabled, reviewToken, recordToken } =
      request;
    if (!featuresReady || !shareRoutesEnabled || !reviewToken || recordToken)
      return;
    const tracker = attempts.current;
    const generation = tracker.generation;
    const controller = new AbortController();
    tracker.flight.push(controller);
    while (tracker.flight.length > MAX_ATTEMPTS_IN_FLIGHT) {
      tracker.flight.shift()?.abort();
    }
    const standing = (): Standing =>
      tracker.newest === request
        ? "newest"
        : tracker.newest !== null && tracker.generation === generation
          ? "replaced"
          : "gone";
    void (async () => {
      let outcome: BootstrapOutcome | null = null;
      try {
        const bootstrap = await loadReviewBootstrap(
          reviewToken,
          controller.signal,
        );
        const caps = bootstrap.capabilities ?? [];
        if (standing() === "gone") return;
        if (!caps.includes("view")) {
          outcome = { kind: "error", error: { failure: { kind: "bad-link" } } };
          return;
        }
        outcome = {
          kind: "online",
          guest: {
            key: shareProjectKey(reviewToken),
            mode: bootstrap.guest_mode ?? "view",
            capabilities: caps,
            transcriptWords: bootstrap.reads_transcript_words,
            author: bootstrap.author ?? null,
          },
        };
      } catch (e: unknown) {
        // Abandoned on purpose (the episode opened elsewhere, or the link or
        // page went away): there is nothing to show or to save.
        if (controller.signal.aborted || standing() !== "newest") return;
        const failure = classifyBootstrapFailure(e);
        if (failure.kind === "bad-link") {
          if (e instanceof ApiError && e.code === "share_not_found") {
            void clearOfflineSnapshot(reviewToken).catch(() => undefined);
          }
          outcome = { kind: "error", error: { failure } };
          return;
        }
        // A saved copy that cannot be read is no saved copy: the guest still
        // gets the cover for the failure, never the host's Home.
        const saved = await loadOfflineSnapshot(reviewToken).catch(
          () => undefined,
        );
        if (standing() !== "newest") return;
        const cachedProject = saved?.project as ProjectView | undefined;
        if (cachedProject && typeof cachedProject === "object") {
          const key = shareProjectKey(reviewToken);
          outcome = {
            kind: "cached",
            guest: {
              key,
              mode: "view",
              capabilities: null,
              transcriptWords: false,
              author: null,
            },
            cached: { key, project: cachedProject },
          };
          return;
        }
        outcome = { kind: "error", error: { failure } };
      } finally {
        tracker.flight = tracker.flight.filter((one) => one !== controller);
        // The episode opening, live or as the saved copy, makes the other
        // attempts pointless: stop them rather than let them hold connections.
        if (
          (outcome?.kind === "online" || outcome?.kind === "cached") &&
          standing() !== "gone"
        ) {
          abortAll(tracker.flight);
        }
        if (standing() !== "gone") {
          const completed = outcome;
          const now = standing();
          setBootstrap((state) =>
            settleBootstrap(state, request, now, completed),
          );
        }
      }
    })();
  }, [request]);

  if (recordToken && !error) {
    return (
      <Suspense
        fallback={
          <GuestLoadingScreen
            label="Joining the room…"
            onRetry={() => window.location.reload()}
          />
        }
      >
        <GuestRoomApp token={recordToken} />
      </Suspense>
    );
  }
  if (reviewToken && (!featuresReady || (shareBootstrapping && !error))) {
    return <GuestLoadingScreen label="Loading project…" onRetry={retry} />;
  }
  if (!featuresReady) {
    return projectLoading();
  }
  if (error && "failure" in error) {
    return (
      <GuestPageCover failure={error.failure} trying={trying} onRetry={retry} />
    );
  }
  if (error) {
    return <ErrorScreen message={error.message} hint={error.hint} />;
  }

  if (shareKey) {
    return (
      <DawProvider
        projectPath={shareKey}
        initialProject={
          cachedGuestProject?.key === shareKey
            ? cachedGuestProject.project
            : null
        }
        guestMode={guestMode}
        shareCapabilities={shareCapabilities}
        shareTranscriptWords={shareTranscriptWords}
        shareAuthor={shareAuthor}
      >
        <Suspense fallback={projectLoading()}>
          <DawApp guestShare />
        </Suspense>
      </DawProvider>
    );
  }

  if (!projectPath) {
    return <HomeScreen />;
  }

  return (
    <DawProvider projectPath={projectPath} initialProject={null}>
      <Suspense fallback={projectLoading()}>
        <DawApp />
      </Suspense>
    </DawProvider>
  );
}

function isGuestLocation(): boolean {
  const project = projectPathFromQuery();
  return shareRouteFromLocation() !== null || isShareProjectKey(project ?? "");
}

export default function App() {
  const notServed = readNotServed();
  if (notServed) {
    return (
      <main>
        <NotServedCover
          notServed={notServed}
          onNavigate={(href) => window.location.assign(href)}
        />
      </main>
    );
  }
  const inner = <AppInner />;
  return (
    <FeatureProvider>
      {isGuestLocation() ? inner : <ModelsProvider>{inner}</ModelsProvider>}
      <AskDialog />
    </FeatureProvider>
  );
}
