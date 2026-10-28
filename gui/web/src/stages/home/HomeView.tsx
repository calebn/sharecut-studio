import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Card } from "../../system/Card";
import { DropOverlay } from "../../system/DropOverlay";
import {
  type ProjectCardData,
  ProjectCardList,
} from "../../system/ProjectCard";
import { Skeleton } from "../../system/Skeleton";
import { StartTile } from "../../system/StartTile";
import { SystemIcon } from "../../system/SystemIcon";
import {
  BrandLockup,
  Button,
  InlineError,
  Menu,
  MenuItem,
  useResizeObserver,
} from "../../ui";
import { OpenOther, type OpenOtherProps } from "./OpenOther";
import { SetupCard, type SetupCardProps } from "./SetupCard";

/** What the Setup card needs from the caller: state and numbers, no callbacks. */
export type SetupData = Pick<
  SetupCardProps,
  "state" | "progress" | "detail" | "sizeLabel"
>;

export type HomeViewProps = {
  /** `loading` shows the skeleton (the 300 ms rule is the caller's); `error` is a failed read with Try again. */
  phase: "loading" | "error" | "empty" | "ready";
  projects: readonly ProjectCardData[];
  /** Null when nothing is needed. */
  setup: SetupData | null;
  showInstallHint: boolean;
  dropActive: boolean;
  /** Real focus on the first card at load; stories leave it off. */
  autoFocusPrimary?: boolean;
  /** Freezes the skeleton at a time (stories). */
  loadingElapsedMs?: number;
  /** Files being dragged over Home; worded in the Import tile's drop line. */
  dropCount?: number;
  /** The skeleton's Retry once loading runs long, and Try again after a failed read. */
  onRetryLoad?: () => void;
  onOpenProject: (id: string, stage: ProjectCardData["stage"]) => void;
  onFindProject: (id: string) => void;
  onImport: () => void;
  onRecord: () => void;
  onOpenOther: () => void;
  onGetReady: () => void;
  onChooseModels: () => void;
  onCancelSetup: () => void;
  onRetrySetup: () => void;
  onDismissSetup: () => void;
  onDismissHint: () => void;
  onHelp: () => void;
  onModels: () => void;
  onConnectAgent: () => void;
  /** Left out while there is no settings surface: the menu then has no Settings row. */
  onSettings?: () => void;
  /** The path form of Open other, for a browser with no OS folder picker. Default: the picker. */
  openOther?: Omit<OpenOtherProps, "onChooseFolder">;
  /** A refusal in plain words with its fix, under the Recent heading. */
  notice?: string;
  /** A quiet progress line while Home works ("Importing 2 files…"). */
  working?: string;
};

/** The picker form: the path fallback needs wiring, so Home shows the picker. */
const NO_OPEN_OTHER: Omit<OpenOtherProps, "onChooseFolder"> = {
  mode: "picker",
  path: "",
  onPathChange: () => {},
  onSubmit: () => {},
};

/** Below this container width Home is the phone layout (40rem at 16 px). */
const PHONE_MAX_PX = 640;

/** True while the host is narrower than the phone breakpoint. */
function useNarrow(host: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  const measure = useCallback(() => {
    const el = host.current;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    setNarrow(width > 0 && width < PHONE_MAX_PX);
  }, [host]);
  useLayoutEffect(measure, [measure]);
  useResizeObserver(host, measure);
  return narrow;
}

function ShareGlyph() {
  return (
    <svg
      className="sys-home-share"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 15V3" />
      <path d="m8 7 4-4 4 4" />
      <path d="M8 11H7a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
    </svg>
  );
}

function HomeHeader({
  onHelp,
  onModels,
  onConnectAgent,
  onSettings,
}: Pick<
  HomeViewProps,
  "onHelp" | "onModels" | "onConnectAgent" | "onSettings"
>) {
  const [open, setOpen] = useState(false);
  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };
  return (
    <header className="sys-home-header">
      <h1 className="sys-home-wordmark">
        <BrandLockup name="ShareCut" className="sys-home-lockup" />
      </h1>
      <div className="sys-home-header-actions">
        <button
          type="button"
          className="sys-icon-btn"
          aria-label="Help"
          title="Help (?)"
          onClick={onHelp}
        >
          <SystemIcon name="circle-help" size={16} />
        </button>
        <Menu
          open={open}
          onOpenChange={setOpen}
          label="More"
          className="ui-menu-root sys-menu sys-header-menu"
          trigger={(props) => (
            <button
              type="button"
              className="sys-icon-btn"
              aria-label="More"
              title="More"
              {...props}
            >
              <SystemIcon name="ellipsis" size={16} />
            </button>
          )}
        >
          <MenuItem onSelect={pick(onModels)}>
            <SystemIcon name="download" size={16} />
            Models
          </MenuItem>
          <MenuItem onSelect={pick(onConnectAgent)}>
            <SystemIcon name="plug" size={16} />
            Connect agent
          </MenuItem>
          {onSettings ? (
            <MenuItem onSelect={pick(onSettings)}>
              <SystemIcon name="settings" size={16} />
              Settings
            </MenuItem>
          ) : null}
        </Menu>
      </div>
    </header>
  );
}

/**
 * Home: two Source tiles over the recent episodes, with the Setup card and the
 * Add to Home Screen hint when they apply. Presentational: data in, callbacks
 * out.
 */
export function HomeView({
  phase,
  projects,
  setup,
  showInstallHint,
  dropActive,
  autoFocusPrimary = false,
  loadingElapsedMs,
  dropCount,
  onRetryLoad,
  onOpenProject,
  onFindProject,
  onImport,
  onRecord,
  onOpenOther,
  onGetReady,
  onChooseModels,
  onCancelSetup,
  onRetrySetup,
  onDismissSetup,
  onDismissHint,
  onHelp,
  onModels,
  onConnectAgent,
  onSettings,
  openOther = NO_OPEN_OTHER,
  notice,
  working,
}: HomeViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(host);
  const empty = phase === "empty";
  useEffect(() => {
    if (!autoFocusPrimary || phase !== "ready") return;
    const root = host.current;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    root
      ?.querySelector<HTMLButtonElement>(
        '[data-project-open]:not([aria-disabled="true"])',
      )
      ?.focus();
  }, [autoFocusPrimary, phase]);
  const tileSize = narrow ? "phone-bar" : empty ? 220 : 160;
  const tiles = (
    <>
      <StartTile
        kind="import"
        size={tileSize}
        state={dropActive ? "drag-hover" : "rest"}
        variant={empty ? "primary" : "default"}
        dragCount={dropCount}
        showKeys={false}
        onActivate={onImport}
      />
      <StartTile
        kind="record"
        size={tileSize}
        showKeys={false}
        onActivate={onRecord}
      />
    </>
  );

  let recent: ReactNode;
  if (phase === "loading") {
    recent = (
      <Skeleton
        layout={narrow ? "list" : "cards"}
        rows={narrow ? 4 : 6}
        elapsedMs={loadingElapsedMs}
        onRetry={onRetryLoad}
      />
    );
  } else if (phase === "error") {
    recent = (
      <div className="sys-home-load-error" role="alert">
        <p className="sys-home-empty">Couldn&apos;t load your episodes.</p>
        {onRetryLoad ? <Button onClick={onRetryLoad}>Try again</Button> : null}
      </div>
    );
  } else if (empty) {
    recent = <p className="sys-home-empty">Your episodes will appear here.</p>;
  } else {
    recent = (
      <ProjectCardList
        projects={projects}
        variant={narrow ? "row" : "card"}
        label="Recent episodes"
        onOpen={onOpenProject}
        onFind={onFindProject}
      />
    );
  }

  return (
    <div
      ref={host}
      className="sys-home"
      data-daw-app-chrome
      data-narrow={narrow || undefined}
      data-phase={phase}
    >
      <div className="sys-home-column">
        <HomeHeader
          onHelp={onHelp}
          onModels={onModels}
          onConnectAgent={onConnectAgent}
          onSettings={onSettings}
        />
        <main className="sys-home-main">
          {narrow ? null : <div className="sys-home-tiles">{tiles}</div>}
          {setup ? (
            <SetupCard
              {...setup}
              onGetReady={onGetReady}
              onChoose={onChooseModels}
              onCancel={onCancelSetup}
              onRetry={onRetrySetup}
              onNotNow={onDismissSetup}
            />
          ) : null}
          <section className="sys-home-recent" aria-labelledby="home-recent">
            <div className="sys-home-recent-head">
              <h2 id="home-recent" className="sys-home-recent-title">
                Recent
              </h2>
              <OpenOther {...openOther} onChooseFolder={onOpenOther} />
            </div>
            <InlineError message={notice} />
            {working ? (
              <p className="sys-home-empty" role="status">
                {working}
              </p>
            ) : null}
            {showInstallHint ? (
              <Card
                tone="hint"
                title={
                  <span className="sys-home-hint">
                    <ShareGlyph />
                    Add to Home Screen for full screen.
                  </span>
                }
                dismissLabel="Dismiss: Add to Home Screen hint"
                onDismiss={onDismissHint}
              >
                {null}
              </Card>
            ) : null}
            {recent}
          </section>
        </main>
      </div>
      {narrow ? (
        <div className="sys-home-bar sys-start-pair">{tiles}</div>
      ) : null}
      {dropActive ? <DropOverlay label="Drop to start an episode" /> : null}
      <p className="sr-only" role="status">
        {dropActive ? "Drop to start an episode" : ""}
      </p>
    </div>
  );
}
