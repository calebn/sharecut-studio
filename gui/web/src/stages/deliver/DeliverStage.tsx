import { useLayoutEffect, useRef, useState } from "react";
import { Cover } from "../../system/Cover";
import type { LinkCopyState } from "../../system/LinkRow";
import { Player } from "../../system/Player";
import { Skeleton } from "../../system/Skeleton";
import { type StageId, VERBS } from "../../system/verbs";
import { Toast, type ToastState } from "../../ui";
import { ChaptersList } from "./ChaptersList";
import { ClipsRow } from "./ClipsRow";
import {
  addChapterAt,
  approveClip,
  type Chapter,
  type Clip,
  clipFiles,
  type DeliverEnv,
  type EpisodeSettings,
  type ExportFile,
  type ExportState,
  exportBlocker,
  primaryAction,
  type ReadinessFacts,
  readinessRows,
  removeChapter,
  removeClip,
  retimeChapter,
  retitleChapter,
} from "./deliverLogic";
import { EpisodeFile } from "./EpisodeFile";
import { ExportButton } from "./ExportButton";
import { ListenLink } from "./ListenLink";
import { Readiness } from "./Readiness";

export type DeliverStageProps = {
  facts: ReadinessFacts;
  /** Episode length in seconds. */
  total: number;
  initialSettings: EpisodeSettings;
  initialChapters: readonly Chapter[];
  initialClips: readonly Clip[];
  saveTo: string;
  exportState: ExportState;
  env?: DeliverEnv;
  /** The Player's clock. */
  clock: { time: string; total: string };
  /** Playhead in seconds, where Add at playhead puts a chapter. */
  playhead: number;
  link: {
    url: string | null;
    copyState?: LinkCopyState;
    openedBy?: readonly { name: string; colorIndex?: number }[];
    noMix?: boolean;
  };
  /** The exported version the listen link is pinned to. */
  pinnedTo: string;
  layout?: "desktop" | "phone";
  state?: "ready" | "loading" | "error";
  /** Guests get Review only; Deliver shows a Cover instead of controls. */
  guest?: boolean;
  /** Toast lifetime in ms. */
  toastMs?: number;
  onFix: (stage: StageId, target?: string) => void;
  onExport: (settings: EpisodeSettings) => void;
  onCancel: () => void;
  onReveal: (file?: ExportFile) => void;
  onDownload: (file?: ExportFile) => void;
  onChangeFolder: () => void;
  onCopyLink: () => void;
  onRefreshMix: () => void;
  onPlayFrom: (seconds: number) => void;
  onPlayClip: (id: string) => void;
  onFindClips: () => void;
  onRetry?: () => void;
};

const EXPORT_KEY = VERBS.find((verb) => verb.id === "export")?.keys[0];

let nextChapter = 0;

/** The Deliver page: Readiness, then the episode file, the listen link, chapters and clips. */
export function DeliverStage({
  facts,
  total,
  initialSettings,
  initialChapters,
  initialClips,
  saveTo,
  exportState,
  env = "app",
  clock,
  playhead,
  link,
  pinnedTo,
  layout = "desktop",
  state = "ready",
  guest = false,
  toastMs = 6000,
  onFix,
  onExport,
  onCancel,
  onReveal,
  onDownload,
  onChangeFolder,
  onCopyLink,
  onRefreshMix,
  onPlayFrom,
  onPlayClip,
  onFindClips,
  onRetry,
}: DeliverStageProps) {
  const [settings, setSettings] = useState(initialSettings);
  const [chapters, setChapters] = useState<readonly Chapter[]>(initialChapters);
  const [clips, setClips] = useState<readonly Clip[]>(initialClips);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [undo, setUndo] = useState<(() => void) | null>(null);
  const [playing, setPlaying] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const phone = layout === "phone";

  const blocker = exportBlocker(settings);
  const action = primaryAction(exportState, env);
  const startExport = () => {
    if (!guest && !blocker && action !== "exporting") onExport(settings);
  };
  const onKey = useRef(startExport);
  useLayoutEffect(() => {
    onKey.current = startExport;
  });
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || !EXPORT_KEY) return;
    const listener = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        !event.repeat &&
        event.key.toUpperCase() === EXPORT_KEY.key
      ) {
        event.preventDefault();
        onKey.current();
      }
    };
    el.addEventListener("keydown", listener);
    return () => el.removeEventListener("keydown", listener);
  }, []);

  if (guest) {
    return (
      <div className="dv-stage" data-layout={layout}>
        <Cover size="region" glyph="eye-off" title="Only the host can deliver">
          You can listen and comment in Review.
        </Cover>
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="dv-stage" data-layout={layout}>
        <Cover
          size="region"
          glyph="octagon-alert"
          title="Could not load Deliver"
          primary={
            onRetry ? { label: "Try again", onClick: onRetry } : undefined
          }
        >
          Your edits are saved.
        </Cover>
      </div>
    );
  }

  const rows = readinessRows(facts);
  const remove = (id: string) => {
    const before = chapters;
    const gone = chapters.find((c) => c.id === id);
    setChapters(removeChapter(chapters, id));
    setToast({
      id: Date.now(),
      message: `Deleted ${gone?.title ?? "chapter"}`,
    });
    setUndo(() => () => {
      setChapters(before);
      setToast(null);
    });
  };
  const pins = [...clipFiles(clips)];
  const exportWithClips: ExportState =
    exportState.phase === "done" || exportState.phase === "stale"
      ? { ...exportState, files: [...exportState.files, ...pins] }
      : exportState;
  const sharedState = state === "loading" ? "loading" : "ready";
  const chaptersPart = (
    <ChaptersList
      chapters={chapters}
      total={total}
      state={sharedState}
      onRetitle={(id, title) =>
        setChapters(retitleChapter(chapters, id, title))
      }
      onRetime={(id, at) => setChapters(retimeChapter(chapters, id, at))}
      onPlayFrom={onPlayFrom}
      onRemove={remove}
      onAdd={() =>
        setChapters(addChapterAt(chapters, playhead, `new-${nextChapter++}`))
      }
    />
  );
  const clipsPart = (
    <ClipsRow
      clips={clips}
      state={sharedState}
      onRetitle={(id, title) =>
        setClips(clips.map((c) => (c.id === id ? { ...c, title } : c)))
      }
      onPlay={onPlayClip}
      onApprove={(id) => setClips(approveClip(clips, id))}
      onRemove={(id) => setClips(removeClip(clips, id))}
      onFind={onFindClips}
    />
  );

  return (
    <div ref={root} className="dv-stage" data-layout={layout} tabIndex={-1}>
      {/* A scroll region must take keyboard focus (axe), even while it only holds a skeleton. */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <section className="dv-page" aria-label="Deliver" tabIndex={0}>
        <Readiness rows={rows} state={sharedState} onFix={onFix} />
        <div className="dv-columns">
          <div className="dv-col">
            <EpisodeFile
              settings={settings}
              total={total}
              saveTo={saveTo}
              exportState={exportWithClips}
              env={env}
              state={sharedState}
              dock={phone}
              onSettings={setSettings}
              onChangeFolder={onChangeFolder}
              onExport={startExport}
              onCancel={onCancel}
              onReveal={onReveal}
              onDownload={onDownload}
            />
            {phone ? null : (
              <>
                {chaptersPart}
                {clipsPart}
              </>
            )}
          </div>
          <div className="dv-col">
            {state === "loading" ? (
              <Skeleton layout="list" rows={2} />
            ) : (
              <ListenLink
                pinnedTo={pinnedTo}
                link={link.url}
                copyState={link.copyState}
                openedBy={link.openedBy}
                noMix={link.noMix ? { onRefresh: onRefreshMix } : undefined}
                share={phone}
                compact={phone}
                highlight={exportState.phase === "done"}
                onCopy={onCopyLink}
              />
            )}
          </div>
        </div>
        {phone ? (
          <>
            {chaptersPart}
            {clipsPart}
          </>
        ) : null}
      </section>
      <div className="dv-foot">
        {phone ? (
          <ExportButton
            action={action}
            blocker={blocker}
            onExport={startExport}
            onReveal={() => onReveal()}
            onDownload={() => onDownload()}
          />
        ) : null}
        <Toast
          className="sys-toast-dock"
          toast={toast}
          timeoutMs={toastMs}
          onUndo={undo ?? undefined}
          onDismiss={() => setToast(null)}
        />
        <Player
          form="bar"
          playing={playing}
          time={clock.time}
          total={clock.total}
          onPlayPause={() => setPlaying(!playing)}
        />
      </div>
    </div>
  );
}
