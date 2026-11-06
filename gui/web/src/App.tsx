import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { loadReviewBootstrap } from "./api";
import { ApiError, errorMessage } from "./utils/apiError";
import { readNotServed } from "./utils/notServed";
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
import { GuestLoadingScreen } from "./stage/frame/GuestLoadingScreen";
import { StageLoading } from "./stage/frame/StageLoading";
import {
  BadLinkCover,
  HostCover,
  NotServedCover,
} from "./stage/frame/StatusCovers";
import { HomeScreen } from "./stages/home/HomeScreen";
import { DawProvider } from "./state/store";
import type { ProjectView } from "./types/project";
import { ErrorScreen, LoadingScreen } from "./ui";
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

function AppInner() {
  const shareRoute = shareRouteFromLocation();
  const reviewToken = shareRoute?.kind === "review" ? shareRoute.token : null;
  const recordToken = shareRoute?.kind === "record" ? shareRoute.token : null;
  const guestToken = reviewToken ?? recordToken;
  const featuresReady = useFeaturesReady();
  const shareRoutesEnabled = useHasFeature(FEATURE_SHARE_UI_ROUTES);
  const projectPath = projectPathFromQuery();
  const [cachedGuestProject, setCachedGuestProject] =
    useState<ProjectView | null>(null);
  const [shareKey, setShareKey] = useState<string | null>(null);
  const [guestMode, setGuestMode] = useState<string | null>(null);
  const [shareCapabilities, setShareCapabilities] = useState<string[] | null>(
    null,
  );
  const [shareAuthor, setShareAuthor] = useState<string | null>(null);
  const [error, setError] = useState<
    | { cover: "bad-link" }
    | {
        message: string;
        hint?: string;
        cover?: "offline" | "failed";
      }
    | null
  >(null);
  const [attempt, setAttempt] = useState(0);
  const projectLoading = () =>
    guestToken || shareKey ? (
      <GuestLoadingScreen
        label="Loading project…"
        onRetry={() => setAttempt((n) => n + 1)}
      />
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
  const [shareBootstrapping, setShareBootstrapping] = useState(
    Boolean(reviewToken),
  );

  const coverRef = useRef<HTMLElement>(null);
  const coverKind = error?.cover;

  useEffect(() => {
    if (coverKind === "offline") {
      const timer = window.setTimeout(() => setAttempt((n) => n + 1), 30_000);
      return () => window.clearTimeout(timer);
    }
  }, [coverKind, attempt]);

  useLayoutEffect(() => {
    if (coverKind) {
      coverRef.current?.focus();
    }
  }, [coverKind]);

  useEffect(() => {
    if (!featuresReady) {
      return;
    }
    if (guestToken && !shareRoutesEnabled) {
      setError({
        message:
          "Share / guest routes (review and record) are not available (online extension not loaded).",
      });
      setShareBootstrapping(false);
      return;
    }
    if (recordToken) {
      setShareKey(null);
      setGuestMode(null);
      setShareCapabilities(null);
      setShareAuthor(null);
      setError(null);
      setShareBootstrapping(false);
      return;
    }
    if (reviewToken) {
      let cancelled = false;
      setShareBootstrapping(true);
      setError(null);
      void (async () => {
        try {
          const bootstrap = await loadReviewBootstrap(reviewToken);
          const caps = bootstrap.capabilities ?? [];
          if (cancelled) {
            return;
          }
          if (!caps.includes("view")) {
            setError({ cover: "bad-link" });
            return;
          }
          setShareKey(shareProjectKey(reviewToken));
          setGuestMode(bootstrap.guest_mode ?? "view");
          setShareCapabilities(caps);
          setShareAuthor(bootstrap.author ?? null);
        } catch (e: unknown) {
          if (cancelled) {
            return;
          }
          if (
            e instanceof ApiError &&
            (e.code === "share_not_found" ||
              (e.code === null && e.status === 404))
          ) {
            if (e.code === "share_not_found") {
              void clearOfflineSnapshot(reviewToken).catch(() => undefined);
            }
            setError({ cover: "bad-link" });
            return;
          }
          const cached = await loadOfflineSnapshot(reviewToken);
          if (cancelled) {
            return;
          }
          const cachedProject = cached?.project as ProjectView | undefined;
          if (cachedProject && typeof cachedProject === "object") {
            setShareKey(shareProjectKey(reviewToken));
            setCachedGuestProject(cachedProject);
            setGuestMode("view");
            setShareCapabilities(null);
            setShareAuthor(null);
            setError(null);
            return;
          }
          const unreachable =
            !(e instanceof ApiError) ||
            e.status === null ||
            e.status === 502 ||
            e.status === 503 ||
            e.status === 504;
          setError({
            message: errorMessage(e),
            cover: unreachable ? "offline" : "failed",
          });
        } finally {
          if (!cancelled) {
            setShareBootstrapping(false);
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
    setError(null);
    setShareBootstrapping(false);
  }, [
    projectPath,
    reviewToken,
    recordToken,
    guestToken,
    featuresReady,
    shareRoutesEnabled,
    attempt,
  ]);

  if (Boolean(reviewToken) && (!featuresReady || shareBootstrapping)) {
    return (
      <GuestLoadingScreen
        label="Loading project…"
        onRetry={() => setAttempt((n) => n + 1)}
      />
    );
  }
  if (!featuresReady) {
    return projectLoading();
  }
  if (error?.cover === "bad-link") {
    return (
      <main ref={coverRef} tabIndex={-1}>
        <BadLinkCover />
      </main>
    );
  }
  if (error?.cover === "offline" || error?.cover === "failed") {
    return (
      <main ref={coverRef} tabIndex={-1}>
        <HostCover
          asleep={error.cover === "offline"}
          message={error.message}
          onRetry={() => setAttempt((n) => n + 1)}
        />
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
        initialProject={cachedGuestProject}
        guestMode={guestMode}
        shareCapabilities={shareCapabilities}
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
    </FeatureProvider>
  );
}
