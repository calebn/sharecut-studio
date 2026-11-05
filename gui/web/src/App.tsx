import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { loadReviewBootstrap } from "./api";
import { ApiError, errorMessage } from "./utils/apiError";
import "./styles/daw.css";
import { FeatureProvider } from "./extensions/FeatureProvider";
import { useFeaturesReady, useHasFeature } from "./extensions/FeaturesContext";
import { FEATURE_SHARE_UI_ROUTES } from "./extensions/features";
import { ModelsProvider } from "./models";
import {
  clearOfflineSnapshot,
  loadOfflineSnapshot,
} from "./services/offlineQueue/offlineStore";
import { isShareProjectKey, shareProjectKey } from "./shareMode";
import { parseShareRoute } from "./shareRoute";
import { HomeScreen } from "./stages/home/HomeScreen";
import { DawProvider } from "./state/store";
import { Cover } from "./system/Cover";
import type { ProjectView } from "./types/project";
import { ErrorScreen, LoadingScreen } from "./ui";

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

type BootstrapError = {
  message: string;
  hint?: string;
  cover?: "bad-link" | "offline" | "failed";
};
type GuestAccess = {
  key: string;
  mode: string;
  capabilities: string[] | null;
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
      error: {
        message:
          "Share / guest routes (review and record) are not available (online extension not loaded).",
      },
    };
  }
  if (request.recordToken) {
    return { ...retained, status: "settled", guest: null, error: null };
  }
  return {
    ...retained,
    status: request.reviewToken ? "pending" : "settled",
    error: null,
  };
}

function AppInner() {
  const shareRoute = shareRouteFromLocation();
  const reviewToken = shareRoute?.kind === "review" ? shareRoute.token : null;
  const recordToken = shareRoute?.kind === "record" ? shareRoute.token : null;
  const featuresReady = useFeaturesReady();
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
  const shareAuthor = guest?.author ?? null;
  const shareBootstrapping = current.status === "pending";

  const coverRef = useRef<HTMLElement>(null);
  const coverKind = error?.cover;

  useEffect(() => {
    if (coverKind === "offline") {
      const timer = window.setTimeout(() => setAttempt((n) => n + 1), 30_000);
      return () => window.clearTimeout(timer);
    }
  }, [coverKind, attempt]);

  useEffect(() => {
    if (coverKind) {
      coverRef.current?.focus();
    }
  }, [coverKind]);

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
          outcome = {
            kind: "error",
            error: {
              message: "This link does not open the project.",
              hint: "Ask the person who shared it for a new link.",
              cover: "bad-link",
            },
          };
          return;
        }
        outcome = {
          kind: "online",
          guest: {
            key: shareProjectKey(reviewToken),
            mode: bootstrap.guest_mode ?? "view",
            capabilities: caps,
            author: bootstrap.author ?? null,
          },
        };
      } catch (e: unknown) {
        if (cancelled) return;
        if (
          e instanceof ApiError &&
          (e.code === "share_not_found" ||
            (e.code === null && e.status === 404))
        ) {
          if (e.code === "share_not_found") {
            void clearOfflineSnapshot(reviewToken).catch(() => undefined);
          }
          outcome = {
            kind: "error",
            error: {
              message: "This link is invalid or has ended.",
              hint: "Ask the host for a new link.",
              cover: "bad-link",
            },
          };
          return;
        }
        const saved = await loadOfflineSnapshot(reviewToken);
        if (cancelled) return;
        const cachedProject = saved?.project as ProjectView | undefined;
        if (cachedProject && typeof cachedProject === "object") {
          const key = shareProjectKey(reviewToken);
          outcome = {
            kind: "cached",
            guest: { key, mode: "view", capabilities: null, author: null },
            cached: { key, project: cachedProject },
          };
          return;
        }
        const unreachable =
          !(e instanceof ApiError) ||
          e.status === null ||
          e.status === 502 ||
          e.status === 503 ||
          e.status === 504;
        outcome = {
          kind: "error",
          error: {
            message: errorMessage(e),
            cover: unreachable ? "offline" : "failed",
          },
        };
      } finally {
        if (!cancelled) {
          const completed = outcome;
          setBootstrap((state) => {
            if (state.request !== request) return state;
            if (completed?.kind === "online") {
              return { ...state, status: "settled", guest: completed.guest };
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

  if (!featuresReady || (Boolean(reviewToken) && shareBootstrapping)) {
    return <LoadingScreen label="Loading project…" />;
  }
  if (error?.cover === "bad-link") {
    return (
      <main ref={coverRef} tabIndex={-1}>
        <Cover size="page" glyph="octagon-alert" title={error.message}>
          {error.hint}
        </Cover>
      </main>
    );
  }
  if (error?.cover === "offline" || error?.cover === "failed") {
    const offline = error.cover === "offline";
    return (
      <main ref={coverRef} tabIndex={-1}>
        <Cover
          size="page"
          glyph={offline ? "cloud-off" : "triangle-alert"}
          title={
            offline ? "The host's computer is asleep" : "This link did not load"
          }
          primary={{
            label: offline ? "Try now" : "Retry",
            onClick: () => setAttempt((n) => n + 1),
          }}
        >
          {offline ? "This page tries again every 30 seconds." : error.message}
        </Cover>
      </main>
    );
  }
  if (error) {
    return <ErrorScreen message={error.message} hint={error.hint} />;
  }

  if (recordToken) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading studio…" />}>
        <GuestRoomApp token={recordToken} />
      </Suspense>
    );
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
        shareAuthor={shareAuthor}
      >
        <Suspense fallback={<LoadingScreen label="Loading project…" />}>
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
      <Suspense fallback={<LoadingScreen label="Loading project…" />}>
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
  const inner = <AppInner />;
  return (
    <FeatureProvider>
      {isGuestLocation() ? inner : <ModelsProvider>{inner}</ModelsProvider>}
    </FeatureProvider>
  );
}
