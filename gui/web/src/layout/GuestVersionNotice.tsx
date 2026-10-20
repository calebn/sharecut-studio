import { useEffect, useRef, useState } from "react";
import { loadReviewVersionStatus, type ReviewVersionStatus } from "../api";
import { useIntervalTick } from "../hooks/useIntervalTick";
import { shareTokenFromKey } from "../shareMode";
import { SANITY_POLL_MS } from "../state/syncCadence";
import { useDaw } from "../state/useDaw";
import { GuestVersionNoticeView } from "./GuestVersionNoticeView";

/**
 * Which version a review link plays. Read when the page loads, every
 * `SANITY_POLL_MS`, and when the tab comes back, so a frozen link learns a
 * newer cut exists and a following link learns the mix changed under it.
 */
export function GuestVersionNotice() {
  const { projectPath, shareAuthor } = useDaw((s) => ({
    projectPath: s.projectPath,
    shareAuthor: s.shareAuthor,
  }));
  const token = shareTokenFromKey(projectPath);
  const [status, setStatus] = useState<ReviewVersionStatus | null>(null);
  const [wake, setWake] = useState(0);
  const heardId = useRef<string | null>(null);
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
        if (heardId.current === null) heardId.current = next.versionId;
        setStatus(next);
      },
      () => {
        // Offline or the link was revoked: keep the last known version.
      },
    );
    return () => controller.abort();
  }, [token, tick, wake]);

  if (!token || !status || !status.versionId) return null;
  return (
    <GuestVersionNoticeView
      label={status.label}
      followsLatest={status.followsLatest}
      newer={status.newer}
      changed={status.followsLatest && status.versionId !== heardId.current}
      author={shareAuthor}
      onReload={() => window.location.reload()}
    />
  );
}
