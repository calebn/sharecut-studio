import { lazy, Suspense, useEffect, useState } from "react";
import { loadReviewBootstrap } from "./api";
import "./styles/daw.css";
import { FeatureProvider } from "./extensions/FeatureProvider";
import { useFeaturesReady, useHasFeature } from "./extensions/FeaturesContext";
import { FEATURE_SHARE_UI_ROUTES } from "./extensions/features";
import { HomeScreen } from "./home/HomeScreen";
import { shareProjectKey } from "./shareMode";
import { parseShareRoute } from "./shareRoute";
import { loadOfflineSnapshot } from "./state/offlineStore";
import { DawProvider } from "./state/store";
import type { ProjectView } from "./types/project";
import { ErrorScreen, LoadingScreen } from "./ui";

void import("./dawApp");

const DawApp = lazy(() =>
  import("./dawApp").then((m) => ({ default: m.DawApp })),
);
const ReviewApp = lazy(() =>
  import("./review/ReviewApp").then((m) => ({ default: m.ReviewApp })),
);

const RecordApp = lazy(() =>
  import("./record/RecordApp").then((m) => ({ default: m.RecordApp })),
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
  const [useReviewApp, setUseReviewApp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shareBootstrapping, setShareBootstrapping] = useState(
    Boolean(reviewToken),
  );

  useEffect(() => {
    if (!featuresReady) {
      return;
    }
    if (guestToken && !shareRoutesEnabled) {
      setError(
        "Share / guest routes (review and record) are not available (online extension not loaded).",
      );
      setShareBootstrapping(false);
      return;
    }
    if (recordToken) {
      setUseReviewApp(false);
      setShareKey(null);
      setGuestMode(null);
      setShareCapabilities(null);
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
          if (caps.includes("view")) {
            setShareKey(shareProjectKey(reviewToken));
            setGuestMode(bootstrap.guest_mode ?? "view");
            setShareCapabilities(caps);
            setUseReviewApp(false);
          } else {
            setUseReviewApp(true);
            setShareKey(null);
            setGuestMode(null);
            setShareCapabilities(null);
          }
        } catch (e: unknown) {
          if (cancelled) {
            return;
          }
          const cached = await loadOfflineSnapshot(reviewToken);
          const cachedProject = cached?.project as ProjectView | undefined;
          if (cachedProject && typeof cachedProject === "object") {
            setShareKey(shareProjectKey(reviewToken));
            setCachedGuestProject(cachedProject);
            setGuestMode("view");
            setShareCapabilities(null);
            setUseReviewApp(false);
            setError(null);
            return;
          }
          setError(e instanceof Error ? e.message : String(e));
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
  ]);

  if (!featuresReady || (Boolean(reviewToken) && shareBootstrapping)) {
    return <LoadingScreen label="Loading project…" />;
  }
  if (error) {
    return <ErrorScreen message={error} />;
  }

  if (recordToken) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading studio…" />}>
        <RecordApp token={recordToken} />
      </Suspense>
    );
  }

  if (reviewToken && useReviewApp) {
    return (
      <Suspense fallback={<LoadingScreen label="Loading review…" />}>
        <ReviewApp token={reviewToken} />
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

export default function App() {
  return (
    <FeatureProvider>
      <AppInner />
    </FeatureProvider>
  );
}
