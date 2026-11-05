import { useEffect, useRef, useState } from "react";
import { loadReviewVersionStatus, reviewVersionAtBootstrap } from "../api";
import { shareTokenFromKey } from "../shareMode";
import { SANITY_POLL_MS } from "../state/syncCadence";
import { useDaw } from "../state/useDaw";
import { useIntervalTick } from "./useIntervalTick";

export type ReviewVersion = {
  /** Label of the version this link plays; null while the host left it unnamed. */
  label: string | null;
  /** The link plays whatever version is current, so the mix can change under the guest. */
  followsLatest: boolean;
  /** A following link now plays a version other than the one this page loaded on. */
  changed: boolean;
};

type Read = ReviewVersion & { versionId: string };

/**
 * Which version a review link plays. Read when the page loads, every
 * `SANITY_POLL_MS`, and when the tab comes back, so a following link learns the
 * mix changed under it. Null for a host project and until the first read.
 */
export function useReviewVersion(): ReviewVersion | null {
  const projectPath = useDaw((s) => s.projectPath);
  const token = shareTokenFromKey(projectPath);
  const [read, setRead] = useState<Read | null>(null);
  const [wake, setWake] = useState(0);
  const baseline = useRef<{ token: string; id: string | null } | null>(null);
  const tick = useIntervalTick(SANITY_POLL_MS, token !== null);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") setWake((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: tick and wake only re-run the read
  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    loadReviewVersionStatus(token, controller.signal).then(
      (next) => {
        if (!next.versionId) return;
        // The page's baseline is the version it loaded on; when that read never
        // succeeded (cached offline start), the first read stands in.
        if (baseline.current?.token !== token || baseline.current.id === null)
          baseline.current = {
            token,
            id: reviewVersionAtBootstrap(token) ?? next.versionId,
          };
        setRead({
          versionId: next.versionId,
          label: next.label,
          followsLatest: next.followsLatest,
          changed: next.followsLatest && next.versionId !== baseline.current.id,
        });
      },
      () => {
        // Offline or the link was revoked: keep the last known version.
      },
    );
    return () => controller.abort();
  }, [token, tick, wake]);

  if (!token || !read) return null;
  return {
    label: read.label,
    followsLatest: read.followsLatest,
    changed: read.changed,
  };
}
