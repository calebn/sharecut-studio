import { Skeleton, type SkeletonPhase } from "../../system/Skeleton";
import { useLoadingClock } from "./loadingClock";

/**
 * A review link's loading screen, until the episode opens. With the episode's
 * name it draws the guest header at once, the name where the studio's header
 * will put it. Without one, nothing draws for 300 ms and then the header bar
 * holds one grey block in the name's place: no word is shown that may be
 * wrong. "Still loading…" with Retry shows at 4 s, counted from the first
 * loading screen. The status line is for assistive technology only.
 */
export function ReviewLoadingScreen({
  name,
  onRetry,
}: {
  name: string | null;
  onRetry?: () => void;
}) {
  const waitedMs = useLoadingClock();
  return (
    <main className="guest-loading" aria-busy="true">
      <h1 className="sr-only">{name ?? "Episode"}</h1>
      <p role="status" className="sr-only">
        {name ? `Loading ${name}…` : "Loading the episode…"}
      </p>
      <Skeleton
        layout="guest"
        waitedMs={waitedMs}
        onRetry={onRetry}
        head={(phase) => <LoadingHeader name={name} phase={phase} />}
      />
    </main>
  );
}

/** The studio's guest header, from the same classes, with what is known so far. */
function LoadingHeader({
  name,
  phase,
}: {
  name: string | null;
  phase: SkeletonPhase;
}) {
  if (!name && phase === "blank") return null;
  return (
    <header className="sys-app-header-host">
      <div className="sys-app-header sys-app-header--loading">
        <div className="sys-header-left">
          <div className="sys-header-guest">
            {name ? (
              <span className="sys-header-title" dir="auto" aria-hidden="true">
                {name}
              </span>
            ) : (
              <span
                className="sys-skeleton-block sys-skeleton-block--title"
                aria-hidden="true"
              />
            )}
            <span className="sys-header-sub" aria-hidden="true">
              {name ? "Loading…" : null}
            </span>
          </div>
        </div>
      </div>
    </header>
  );
}
