import { lazy, Suspense, useEffect, useState } from "react";
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
  | { cover: "bad-link" }
  | { cover: "host"; failure: GuestLoadFailure }
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
        ? { cover: "host", failure: { kind: "no-review-routes" } }
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
  const trying = shareBootstrapping && error !== null;
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
    error && "cover" in error && error.cover === "host"
      ? guestLoadCover(error.failure).autoRetryMs
      : null;

  // Counts only while the cover waits: a press or an attempt in flight cancels
  // it, and a fresh one starts when the attempt settles.
  useEffect(() => {
    if (autoRetryMs === null || trying) return;
    const timer = window.setTimeout(
      () => setAttempt((n) => n + 1),
      autoRetryMs,
    );
    return () => window.clearTimeout(timer);
  }, [autoRetryMs, trying]);

  useEffect(() => {
    const { featuresReady, shareRoutesEnabled, reviewToken, recordToken } =
      request;
    if (!featuresReady || !shareRoutesEnabled || !reviewToken || recordToken)
      return;
    let cancelled = false;
    void (async () => {
      let outcome: BootstrapOutcome | null = null;
      try {
        const bootstrap = await loadReviewBootstrap(reviewToken);
        const caps = bootstrap.capabilities ?? [];
        if (cancelled) return;
        if (!caps.includes("view")) {
          outcome = { kind: "error", error: { cover: "bad-link" } };
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
        if (cancelled) return;
        const failure = classifyBootstrapFailure(e);
        if (failure.kind === "bad-link") {
          if (e instanceof ApiError && e.code === "share_not_found") {
            void clearOfflineSnapshot(reviewToken).catch(() => undefined);
          }
          outcome = { kind: "error", error: { cover: "bad-link" } };
          return;
        }
        const saved = await loadOfflineSnapshot(reviewToken);
        if (cancelled) return;
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
        outcome = { kind: "error", error: { cover: "host", failure } };
      } finally {
        if (!cancelled) {
          const completed = outcome;
          setBootstrap((state) => {
            if (state.request !== request) return state;
            if (completed?.kind === "online") {
              return {
                ...state,
                status: "settled",
                guest: completed.guest,
                error: null,
              };
            }
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
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
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
  if (error && "cover" in error) {
    return (
      <GuestPageCover
        failure={
          error.cover === "bad-link" ? { kind: "bad-link" } : error.failure
        }
        trying={trying}
        onRetry={retry}
      />
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
